import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AgentFlowVersionStatus, Prisma } from '@prisma/client';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { PrismaService } from '../../prisma/prisma.service';
import { BUILTIN_DIRECT_FLOW_ID } from './builtin-flow.service';
import type { AgentFlowVersionResponse } from './agent-flow.service';
import {
  calculateFlowDefinitionDigest,
  validateFlowDraftDefinition,
  validateFlowDefinition,
} from './definition/flow-definition.validator';
import {
  inspectFlowDefinition,
  normalizeFlowDefinition,
  type FlowDefinitionInspection,
  type FlowDefinitionUpgradeReport,
} from './definition/flow-definition.versioning';
import { FlowRuntimeValidator } from './runtime/flow-runtime-validator.service';
import { toAgentFlowVersionResponse } from './agent-flow-version.mapper';

const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;

/** FlowVersion 结构校验的管理端返回结构。 */
export interface AgentFlowVersionValidationResponse {
  valid: boolean;
  errors: Array<{ path: string; rule: string; message: string }>;
  digest?: string;
}

/** 历史版本升级为当前草稿的返回结构。 */
export interface AgentFlowVersionUpgradeResponse {
  version: AgentFlowVersionResponse;
  report: FlowDefinitionUpgradeReport;
}

/**
 * AgentFlow 版本服务
 * @description 管理草稿编辑与发布版本的不可变性。Flow 聚合创建、导入和回滚由 AgentFlowService 负责。
 */
@Injectable()
export class AgentFlowVersionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeValidator: FlowRuntimeValidator,
  ) {}

  /**
   * 覆盖一个草稿版本的 Definition
   * @param versionId 待编辑的 FlowVersion ID
   * @param input 管理端提交的未知 FlowDefinition JSON
   * @param actorId 执行修改的管理员用户ID
   * @returns 当前草稿版本的更新结果
   * @description 已发布和归档版本是不可变工件。DRAFT 更新会在一个可串行化事务中同步版本 JSON、Flow 摘要和审计记录。
   */
  async updateDraft(
    versionId: string,
    input: unknown,
    actorId: string,
  ): Promise<AgentFlowVersionResponse> {
    const definition = this.requireValidDraftDefinition(input);
    return this.runSerializableTransaction(async (transaction) => {
      const version = await transaction.agentFlowVersion.findUnique({
        where: { id: versionId },
      });
      if (!version) {
        throw new NotFoundException('Flow 版本不存在');
      }
      // 内置版本恒为 PUBLISHED，下面的状态检查本就挡得住；这里显式拦一次是为了给出
      // 准确原因，而不是让人以为「再建个草稿就能改」
      if (version.flowId === BUILTIN_DIRECT_FLOW_ID) {
        throw new BadRequestException(
          '内置 Flow 由系统维护，不可编辑；如需自定义请导出后另存为新的 Flow',
        );
      }
      if (version.status !== AgentFlowVersionStatus.DRAFT) {
        throw new BadRequestException('已发布或归档版本不可编辑');
      }

      const updatedVersion = await transaction.agentFlowVersion.update({
        where: { id: versionId },
        data: {
          definition: this.toInputJsonValue(definition),
          schemaVersion: definition.schemaVersion,
          digest: null,
        },
      });
      await transaction.agentFlow.update({
        where: { id: version.flowId },
        data: {
          name: definition.name,
          description: definition.description ?? '',
        },
      });
      await transaction.agentFlowAuditLog.create({
        data: {
          flowId: version.flowId,
          versionId,
          action: 'DRAFT_UPDATED',
          actorId,
          digest: null,
        },
      });
      return toAgentFlowVersionResponse(updatedVersion);
    });
  }

  /**
   * 发布一个草稿版本
   * @param versionId 待发布的 FlowVersion ID
   * @param actorId 执行发布的管理员用户ID
   * @returns 返回已锁定 digest 的发布版本
   * @description 发布在可串行化事务中完成：结构校验 Definition、归档旧发布版本、写入新 digest、切换 Flow 当前版本并追加审计记录。
   */
  async publish(
    versionId: string,
    actorId: string,
  ): Promise<AgentFlowVersionResponse> {
    return this.runSerializableTransaction(async (transaction) => {
      const version = await transaction.agentFlowVersion.findUnique({
        where: { id: versionId },
      });
      if (!version) {
        throw new NotFoundException('Flow 版本不存在');
      }
      if (version.flowId === BUILTIN_DIRECT_FLOW_ID) {
        throw new BadRequestException(
          '内置 Flow 由系统维护，不可发布新版本；如需自定义请导出后另存为新的 Flow',
        );
      }
      if (version.status !== AgentFlowVersionStatus.DRAFT) {
        throw new BadRequestException('只有草稿版本可以发布');
      }

      const definition = this.requireValidDefinition(version.definition);
      this.requireRuntimeValidDefinition(definition);
      const flow = await transaction.agentFlow.findUnique({
        where: { id: version.flowId },
      });
      if (!flow) {
        throw new NotFoundException('Flow 不存在');
      }

      const now = new Date();
      const digest = calculateFlowDefinitionDigest(definition);
      await transaction.agentFlowVersion.updateMany({
        where: {
          flowId: flow.id,
          status: AgentFlowVersionStatus.PUBLISHED,
          id: { not: versionId },
        },
        data: {
          status: AgentFlowVersionStatus.ARCHIVED,
          archivedAt: now,
        },
      });
      const publishedVersion = await transaction.agentFlowVersion.update({
        where: { id: versionId },
        data: {
          status: AgentFlowVersionStatus.PUBLISHED,
          digest,
          publishedAt: now,
          archivedAt: null,
        },
      });
      await transaction.agentFlow.update({
        where: { id: flow.id },
        data: { publishedVersionId: versionId },
      });
      await transaction.agentFlowAuditLog.create({
        data: {
          flowId: flow.id,
          versionId,
          action: 'PUBLISHED',
          actorId,
          digest,
        },
      });
      return toAgentFlowVersionResponse(publishedVersion);
    });
  }

  /**
   * 导出指定版本的 Definition JSON
   * @param versionId 待导出的 FlowVersion ID
   * @returns 返回不含持久化元数据的 FlowDefinition 副本
   * @description 导出边界只暴露可移植的 JSON 工件，不携带版本 ID、digest、审计、任务或用户信息。
   */
  async exportDefinition(versionId: string): Promise<object> {
    const version = await this.prisma.agentFlowVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) {
      throw new NotFoundException('Flow 版本不存在');
    }
    return toDefinitionObject(version.definition);
  }

  /**
   * 校验指定版本的 Definition
   * @param versionId 待校验的 FlowVersion ID
   * @returns 返回结构校验错误或可发布的语义 digest
   * @description 该操作不写版本、审计或 digest 列，同时返回 JSON 结构与当前模型、工具组、技能闭集校验结果。
   */
  async validate(
    versionId: string,
  ): Promise<AgentFlowVersionValidationResponse> {
    const version = await this.prisma.agentFlowVersion.findUnique({
      where: { id: versionId },
    });
    if (!version) {
      throw new NotFoundException('Flow 版本不存在');
    }
    const normalized = normalizeFlowDefinition(version.definition);
    if (!normalized.success) {
      return { valid: false, errors: [...normalized.inspection.errors] };
    }
    return this.validateDefinition(normalized.definition);
  }

  /**
   * 将一个可升级历史版本物化为新的当前版本草稿
   * @param versionId 作为升级来源的历史版本 ID
   * @param actorId 执行升级的管理员用户 ID
   * @returns 返回新草稿和确定性迁移摘要
   * @description 源工件、发布指针和 Agent 绑定保持不变；同一 Flow 已有草稿时拒绝覆盖。
   */
  async upgradeToCurrentDraft(
    versionId: string,
    actorId: string,
  ): Promise<AgentFlowVersionUpgradeResponse> {
    return this.runSerializableTransaction(async (transaction) => {
      const source = await transaction.agentFlowVersion.findUnique({
        where: { id: versionId },
      });
      if (!source) throw new NotFoundException('Flow 版本不存在');
      if (source.flowId === BUILTIN_DIRECT_FLOW_ID) {
        throw new BadRequestException('内置 Flow 由系统维护，不能生成升级草稿');
      }
      const normalized = normalizeFlowDefinition(source.definition);
      const inspection = normalized.inspection;
      if (
        !normalized.success ||
        inspection.status !== 'upgradeable' ||
        !inspection.report
      ) {
        throw new BadRequestException({
          message: '该 Flow 版本不存在可靠的自动升级路径',
          errors: inspection.errors,
        });
      }
      if (!source.digest || normalized.sourceDigest !== source.digest) {
        throw new BadRequestException(
          '升级源版本摘要与 Definition 不一致，历史工件可能已被修改',
        );
      }
      const existingDraft = await transaction.agentFlowVersion.findFirst({
        where: {
          flowId: source.flowId,
          status: AgentFlowVersionStatus.DRAFT,
        },
        select: { id: true, version: true },
      });
      if (existingDraft) {
        throw new BadRequestException(
          `该 Flow 已有 v${existingDraft.version} 草稿，请先处理现有草稿`,
        );
      }
      const latest = await transaction.agentFlowVersion.findFirst({
        where: { flowId: source.flowId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const draft = await transaction.agentFlowVersion.create({
        data: {
          flowId: source.flowId,
          version: (latest?.version ?? 0) + 1,
          status: AgentFlowVersionStatus.DRAFT,
          definition: this.toInputJsonValue(normalized.definition),
          digest: null,
          schemaVersion: normalized.definition.schemaVersion,
          createdById: actorId,
        },
      });
      await transaction.agentFlowAuditLog.create({
        data: {
          flowId: source.flowId,
          versionId: draft.id,
          action: 'UPGRADED',
          actorId,
          digest: null,
          upgradeContext: {
            sourceVersionId: source.id,
            targetVersionId: draft.id,
            fromSchemaVersion: inspection.report.fromVersion,
            toSchemaVersion: inspection.report.toVersion,
          },
        },
      });
      return {
        version: toAgentFlowVersionResponse(draft),
        report: inspection.report,
      };
    });
  }

  /**
   * 校验一份未保存的 FlowDefinition
   * @param input 管理端当前画布中的完整 Definition
   * @returns 返回结构与运行时能力闭集校验结果；合法时同时返回语义摘要
   * @description 只执行纯校验，不查询版本，也不写入版本、审计或 digest，供编辑器实时检查当前草稿。
   */
  validateDefinition(input: unknown): AgentFlowVersionValidationResponse {
    const result = validateFlowDefinition(input);
    if (!result.success) {
      return { valid: false, errors: result.errors };
    }
    const runtimeResult = this.runtimeValidator.validate(result.definition);
    if (!runtimeResult.valid) {
      return { valid: false, errors: runtimeResult.errors };
    }
    return {
      valid: true,
      errors: [],
      digest: calculateFlowDefinitionDigest(result.definition),
    };
  }

  /**
   * 预检外部 Definition 并在可行时返回当前版本内存模型
   * @param input 管理端尚未写入数据库的 JSON 工件
   * @returns 返回版本状态、错误、规范化 Definition 与可选升级摘要
   * @description 只执行确定性解析和迁移，不创建 Flow 或草稿，供导入前确认升级结果。
   */
  inspectDefinition(input: unknown): FlowDefinitionInspection {
    return inspectFlowDefinition(input);
  }

  /**
   * 校验待写入的 FlowDefinition
   * @param input 外部提交的未知 JSON
   * @returns 返回结构合法的 FlowDefinition
   * @description 版本写入和发布都必须使用同一纯领域校验器，避免导入或 API 编辑绕过节点图约束。
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
   * 校验待保存的当前版本草稿
   * @param input 管理端提交的未知 Definition
   * @returns 返回字段与关键引用结构有效的当前 Definition
   * @description 允许空 Loop、断边和多入口等编辑中间态；完整发布校验仍由 requireValidDefinition 执行。
   */
  private requireValidDraftDefinition(input: unknown): FlowDefinition {
    const result = validateFlowDraftDefinition(input);
    if (!result.success) {
      throw new BadRequestException({
        message: 'FlowDefinition 草稿结构无效',
        errors: result.errors,
      });
    }
    return result.definition;
  }

  /**
   * 校验 Definition 在当前能力闭集内可被发布
   * @param definition 已通过 JSON 结构校验的 FlowDefinition
   * @returns 无返回值
   * @description 发布期拒绝引用未知模型、工具组或技能；agent-default 与用户级凭据的实际锁定仍由任务创建期校验。
   */
  private requireRuntimeValidDefinition(definition: FlowDefinition): void {
    const result = this.runtimeValidator.validate(definition);
    if (!result.valid) {
      throw new BadRequestException({
        message: 'Flow 运行时校验失败',
        errors: result.errors,
      });
    }
  }

  /**
   * 在可串行化事务中执行版本写入
   * @param operation 接收事务客户端并执行读写的操作
   * @returns 返回成功提交后的操作结果
   * @description 仅对 PostgreSQL P2034 序列化冲突重试，避免并发编辑将版本 JSON 与审计记录写成不一致状态。
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
   * @description JSON 序列化会剥离 TypeScript readonly 标记，保证 Prisma 接收独立的标准 JSON 数据。
   */
  private toInputJsonValue(definition: FlowDefinition): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(definition)) as Prisma.InputJsonValue;
  }
}

/**
 * 将 Prisma JSON 原样收敛为可导出的对象
 * @param value 数据库存储的 Definition JSON
 * @returns 返回独立对象副本
 * @description 导出必须保留历史工件原文，不能把内存规范化后的 v10 冒充 v9 原件。
 */
function toDefinitionObject(value: Prisma.JsonValue): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('FlowVersion 中的 Definition 不是对象');
  }
  return JSON.parse(JSON.stringify(value)) as object;
}
