import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentFlowVersionStatus,
  type AgentFlow,
  type AgentFlowVersion,
  Prisma,
} from '@prisma/client';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { PrismaService } from '../../prisma/prisma.service';
import { BUILTIN_DIRECT_FLOW_ID } from './builtin-flow.service';
import {
  validateFlowDefinition,
  type FlowDefinitionValidationError,
} from './definition/flow-definition.validator';
import { FlowRuntimeValidator } from './runtime/flow-runtime-validator.service';
import { toAgentFlowVersionResponse } from './agent-flow-version.mapper';

const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;

/** AgentFlow 版本的管理端返回结构。 */
export interface AgentFlowVersionResponse {
  id: string;
  flowId: string;
  version: number;
  status: AgentFlowVersionStatus;
  /**
   * 该版本的 Definition 工件原文
   * @description 类型是 `object` 而不是 `FlowDefinition`：存量版本可能是旧 schemaVersion 或
   * 其他不再符合当前契约的工件，读取时把它断言成合法 Definition 是在撒谎。是否可用由
   * `schemaCompatible` 单独表达，管理端据此决定能不能编辑、校验、发布。
   */
  definition: object;
  /** 该工件是否仍符合当前 Definition 契约 */
  schemaCompatible: boolean;
  /** 不兼容时的逐条原因；兼容时不带此字段 */
  schemaErrors?: FlowDefinitionValidationError[];
  digest: string | null;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  archivedAt: number | null;
}

/** AgentFlow 的管理端返回结构。 */
export interface AgentFlowResponse {
  id: string;
  name: string;
  description: string;
  publishedVersionId: string | null;
  createdAt: number;
  updatedAt: number;
  draftVersion?: AgentFlowVersionResponse;
}

/** Flow 列表的管理端摘要。 */
export interface AgentFlowSummaryResponse extends AgentFlowResponse {
  publishedVersion: AgentFlowVersionResponse | null;
}

/** Flow 详情的管理端返回结构。 */
export interface AgentFlowDetailResponse extends AgentFlowSummaryResponse {
  versions: AgentFlowVersionResponse[];
}

/**
 * AgentFlow 控制面服务
 * @description 管理 Flow 的草稿、版本、发布和审计。运行时执行、Temporal 调度与 SSE 事件不属于本服务。
 */
@Injectable()
export class AgentFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeValidator: FlowRuntimeValidator,
  ) {}

  /**
   * 创建逻辑 Flow 与其首个草稿版本
   * @param input 外部提交的 FlowDefinition JSON
   * @param actorId 发起操作的管理员用户ID
   * @returns 返回新建 Flow 及其 version 1 DRAFT
   * @description 先执行纯结构校验，再在同一可串行化事务中创建 Flow、版本和最小审计记录；草稿不计算发布 digest。
   */
  async create(input: unknown, actorId: string): Promise<AgentFlowResponse> {
    const definition = this.requireValidDefinition(input);
    return this.runSerializableTransaction(async (transaction) => {
      const flow = await transaction.agentFlow.create({
        data: {
          name: definition.name,
          description: definition.description ?? '',
          createdById: actorId,
        },
      });
      const draftVersion = await transaction.agentFlowVersion.create({
        data: {
          flowId: flow.id,
          version: 1,
          status: AgentFlowVersionStatus.DRAFT,
          definition: this.toInputJsonValue(definition),
          digest: null,
          schemaVersion: definition.schemaVersion,
          createdById: actorId,
        },
      });
      await transaction.agentFlowAuditLog.create({
        data: {
          flowId: flow.id,
          versionId: draftVersion.id,
          action: 'CREATED',
          actorId,
          digest: null,
        },
      });

      return {
        ...this.toFlowResponse(flow),
        draftVersion: toAgentFlowVersionResponse(draftVersion),
      };
    });
  }

  /**
   * 列出全部逻辑 Flow 及其当前发布版本摘要
   * @returns 返回按创建时间倒序排列的 Flow 摘要
   * @description 列表只关联当前 publishedVersion，不加载所有历史版本、审计记录或任务数据。
   */
  async list(): Promise<AgentFlowSummaryResponse[]> {
    const flows = await this.prisma.agentFlow.findMany({
      include: { publishedVersion: true },
      orderBy: { createdAt: 'desc' },
    });
    return flows.map((flow) => this.toSummaryResponse(flow));
  }

  /**
   * 查询一个 Flow 及其版本历史
   * @param flowId 逻辑 Flow ID
   * @returns 返回 Flow、当前发布版本与全部版本摘要
   * @description 版本 JSON 是控制面工件，会经同一结构校验器读取；任务、审批和审计数据不随详情返回。
   */
  async get(flowId: string): Promise<AgentFlowDetailResponse> {
    const flow = await this.prisma.agentFlow.findUnique({
      where: { id: flowId },
      include: {
        publishedVersion: true,
        versions: { orderBy: { version: 'desc' } },
      },
    });
    if (!flow) {
      throw new NotFoundException('Flow 不存在');
    }
    return {
      ...this.toSummaryResponse(flow),
      versions: flow.versions.map((version) =>
        toAgentFlowVersionResponse(version),
      ),
    };
  }

  /**
   * 将 Definition 导入为指定 Flow 的新草稿版本
   * @param flowId 导入目标的逻辑 Flow ID
   * @param input 外部导入的未知 FlowDefinition JSON
   * @param actorId 发起导入的管理员用户ID
   * @returns 返回新建的 DRAFT 版本
   * @description 导入永远递增创建新版本，不覆盖同 digest 的历史草稿或已发布工件；版本号分配、名称同步和审计在同一事务内完成。
   */
  async importDefinition(
    flowId: string,
    input: unknown,
    actorId: string,
  ): Promise<AgentFlowVersionResponse> {
    assertNotBuiltinFlow(flowId);
    const definition = this.requireValidDefinition(input);
    return this.runSerializableTransaction(async (transaction) => {
      const flow = await transaction.agentFlow.findUnique({
        where: { id: flowId },
      });
      if (!flow) {
        throw new NotFoundException('Flow 不存在');
      }
      const latestVersion = await transaction.agentFlowVersion.findFirst({
        where: { flowId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = await transaction.agentFlowVersion.create({
        data: {
          flowId,
          version: (latestVersion?.version ?? 0) + 1,
          status: AgentFlowVersionStatus.DRAFT,
          definition: this.toInputJsonValue(definition),
          digest: null,
          schemaVersion: definition.schemaVersion,
          createdById: actorId,
        },
      });
      await transaction.agentFlow.update({
        where: { id: flowId },
        data: {
          name: definition.name,
          description: definition.description ?? '',
        },
      });
      await transaction.agentFlowAuditLog.create({
        data: {
          flowId,
          versionId: version.id,
          action: 'IMPORTED',
          actorId,
          digest: null,
        },
      });
      return toAgentFlowVersionResponse(version);
    });
  }

  /**
   * 将一个历史版本重新设为当前发布版本
   * @param flowId 逻辑 Flow ID
   * @param versionId 目标历史 FlowVersion ID
   * @param actorId 执行回滚的管理员用户ID
   * @returns 返回恢复为 PUBLISHED 的版本
   * @description 回滚只切换状态和发布指针，不修改目标版本的 Definition 或 digest；当前发布版本会先归档并留下审计记录。
   */
  async rollback(
    flowId: string,
    versionId: string,
    actorId: string,
  ): Promise<AgentFlowVersionResponse> {
    assertNotBuiltinFlow(flowId);
    return this.runSerializableTransaction(async (transaction) => {
      const flow = await transaction.agentFlow.findUnique({
        where: { id: flowId },
      });
      if (!flow) {
        throw new NotFoundException('Flow 不存在');
      }
      const targetVersion = await transaction.agentFlowVersion.findUnique({
        where: { id: versionId },
      });
      if (!targetVersion || targetVersion.flowId !== flowId) {
        throw new NotFoundException('Flow 版本不存在');
      }
      if (
        targetVersion.status !== AgentFlowVersionStatus.PUBLISHED &&
        targetVersion.status !== AgentFlowVersionStatus.ARCHIVED
      ) {
        throw new BadRequestException('只有已发布或已归档版本可以回滚');
      }
      this.requireRollbackTargetStillRunnable(targetVersion.definition);

      const now = new Date();
      await transaction.agentFlowVersion.updateMany({
        where: {
          flowId,
          status: AgentFlowVersionStatus.PUBLISHED,
          id: { not: versionId },
        },
        data: {
          status: AgentFlowVersionStatus.ARCHIVED,
          archivedAt: now,
        },
      });
      const restoredVersion = await transaction.agentFlowVersion.update({
        where: { id: versionId },
        data: {
          status: AgentFlowVersionStatus.PUBLISHED,
          publishedAt: now,
          archivedAt: null,
        },
      });
      await transaction.agentFlow.update({
        where: { id: flowId },
        data: { publishedVersionId: versionId },
      });
      await transaction.agentFlowAuditLog.create({
        data: {
          flowId,
          versionId,
          action: 'ROLLED_BACK',
          actorId,
          digest: targetVersion.digest,
        },
      });
      return toAgentFlowVersionResponse(restoredVersion);
    });
  }

  /**
   * 删除一个从未被任务引用的 Flow
   * @param flowId 逻辑 Flow ID
   * @returns 无返回值
   * @description 只允许删除"干净"的 Flow：任何版本一旦被 StreamTask 锁定过，它就是审计链的一部分，
   * 数据库层面 `StreamTask.flowVersionId` 是 `onDelete: Restrict`，这里把该约束翻译成可读的拒绝原因，
   * 而不是让管理端撞上裸 Prisma 外键错误。同理，被 Agent 绑定的版本不静默解绑——`defaultFlowVersionId`
   * 是 `SetNull`，删了会让那个 Agent 无声地退回非 Flow 链路，必须让操作者先显式解绑。
   */
  async remove(flowId: string): Promise<void> {
    assertNotBuiltinFlow(flowId);
    await this.runSerializableTransaction(async (transaction) => {
      const flow = await transaction.agentFlow.findUnique({
        where: { id: flowId },
        include: { versions: { select: { id: true } } },
      });
      if (!flow) {
        throw new NotFoundException('Flow 不存在');
      }
      const versionIds = flow.versions.map((version) => version.id);

      const taskCount = await transaction.streamTask.count({
        where: { flowVersionId: { in: versionIds } },
      });
      if (taskCount > 0) {
        throw new BadRequestException(
          `该 Flow 已被 ${taskCount} 个任务运行过，属于审计链的一部分，不可删除`,
        );
      }
      const boundAgents = await transaction.agent.findMany({
        where: { defaultFlowVersionId: { in: versionIds } },
        select: { name: true },
      });
      if (boundAgents.length > 0) {
        throw new BadRequestException(
          `请先解除智能体绑定：${boundAgents.map((agent) => agent.name).join('、')}`,
        );
      }

      // 先摘掉 Flow -> 版本的发布指针，否则删版本会被该外键挡住
      await transaction.agentFlow.update({
        where: { id: flowId },
        data: { publishedVersionId: null },
      });
      await transaction.agentFlowVersion.deleteMany({ where: { flowId } });
      // 审计日志随 Flow 级联删除
      await transaction.agentFlow.delete({ where: { id: flowId } });
    });
  }

  /**
   * 校验回滚目标在当前能力闭集下仍可运行
   * @param definition 目标历史版本的 Definition JSON
   * @returns 无返回值
   * @description 历史版本发布时引用的模型、工具组或技能可能已经下线。回滚只切指针不校验的话，
   * 这个版本会成为线上发布版本，然后在每个终端用户的任务创建期编译失败——失败落在用户身上，
   * 而不是执行回滚的管理员。这里用与 publish 相同的发布期校验，把错误还给操作者。
   */
  private requireRollbackTargetStillRunnable(definition: unknown): void {
    const parsed = validateFlowDefinition(definition);
    if (!parsed.success) {
      throw new BadRequestException({
        message: '回滚目标版本的 FlowDefinition 已不合法',
        errors: parsed.errors,
      });
    }
    const runtimeResult = this.runtimeValidator.validate(parsed.definition);
    if (!runtimeResult.valid) {
      throw new BadRequestException({
        message: '回滚目标版本引用的能力已不可用',
        errors: runtimeResult.errors,
      });
    }
  }

  /**
   * 校验待保存的 FlowDefinition
   * @param input 外部提交的未知 JSON
   * @returns 返回结构合法的 FlowDefinition
   * @description 将纯领域校验结果转换为 HTTP 可展示的 BadRequestException，不访问能力注册表或其他运行时依赖。
   */
  private requireValidDefinition(input: unknown): FlowDefinition {
    const result = validateFlowDefinition(input);
    if (!result.success) {
      throw new BadRequestException({
        message: 'FlowDefinition 校验失败',
        errors: result.errors,
      });
    }
    return result.definition;
  }

  /**
   * 在可串行化事务中执行 Flow 控制面写入
   * @param operation 接收事务客户端并执行读写的操作
   * @returns 返回成功提交后的操作结果
   * @description 仅针对 PostgreSQL P2034 序列化冲突有限重试，确保并发发布等操作不会因读写竞争产生半完成状态。
   */
  private async runSerializableTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const canRetry =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS - 1;
        if (!canRetry) {
          throw error;
        }
      }
    }

    throw new Error('可串行化事务重试状态异常');
  }

  /**
   * 将 FlowDefinition 转为 Prisma JSON 输入值
   * @param definition 已完成结构校验的 FlowDefinition
   * @returns 返回可写入 Json 字段的深拷贝值
   * @description JSON 序列化同时剥离 TypeScript readonly 标记，避免调用方后续修改原对象影响待写入的业务数据。
   */
  private toInputJsonValue(definition: FlowDefinition): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(definition)) as Prisma.InputJsonValue;
  }

  /**
   * 映射 AgentFlow 为管理端响应
   * @param flow Prisma 查询得到的逻辑 Flow
   * @returns 返回不包含版本 JSON 的 Flow 摘要
   * @description 控制面列表可复用此映射，避免把审计或任务数据暴露到 Flow 基础响应中。
   */
  private toFlowResponse(flow: AgentFlow): AgentFlowResponse {
    return {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      publishedVersionId: flow.publishedVersionId,
      createdAt: flow.createdAt.getTime(),
      updatedAt: flow.updatedAt.getTime(),
    };
  }

  /**
   * 映射带当前发布版本的 Flow 摘要
   * @param flow 已预加载 publishedVersion 的 Prisma 查询结果
   * @returns 返回可安全展示的 Flow 列表项
   * @description 只投影当前发布版本，避免列表端点加载历史版本 JSON 或审计数据。
   */
  private toSummaryResponse(
    flow: AgentFlow & { publishedVersion: AgentFlowVersion | null },
  ): AgentFlowSummaryResponse {
    return {
      ...this.toFlowResponse(flow),
      publishedVersion: flow.publishedVersion
        ? toAgentFlowVersionResponse(flow.publishedVersion)
        : null,
    };
  }
}

/**
 * 内置 Flow 的写保护
 * @param flowId 目标 Flow 标识
 * @returns 无返回值
 * @description 内置 Flow 由代码定义、启动时 ensure，且**所有未绑定 Flow 的 Agent 都在跑它**。
 * 允许改或删它就是允许一次误操作打掉全站默认回复链路，而下次启动 ensure 又会把改动覆盖回去——
 * 那种"改了但过一会儿又变回来"的行为比直接拒绝更难排查。
 *
 * 要基于它做自己的图，用导出/导入另存一份。
 */
function assertNotBuiltinFlow(flowId: string): void {
  if (flowId === BUILTIN_DIRECT_FLOW_ID) {
    throw new BadRequestException(
      '内置 Flow 由系统维护，不可编辑或删除；如需自定义请导出后另存为新的 Flow',
    );
  }
}
