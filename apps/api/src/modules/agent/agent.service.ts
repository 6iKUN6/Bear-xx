import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentFlowVersionStatus,
  ManagementAuditAction,
  ManagementAuditTargetType,
  MembershipTier,
  type Agent,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { collectFlowToolGroups } from '../agent-flow/definition/flow-tool-groups';
import { createFlowDefinitionPreset } from '../agent-flow/definition/flow-definition.templates';
import { validateFlowDefinition } from '../agent-flow/definition/flow-definition.validator';
import { AgentDefinitionService } from './agent-definition.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AgentResponseDto } from './dto/agent-response.dto';
import {
  AgentAccessService,
  type MembershipAccessSubject,
  type AgentAccessDecision,
} from '../agent-access/agent-access.service';

const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;

/**
 * 智能体 CRUD
 * @description 管理数据化的智能体定义。写操作后失效 AgentDefinitionService 缓存。
 * 策略枚举合法性由 DTO @IsEnum 保证；工具组/技能的闭集成员性由运行时装配阶段优雅过滤，此处不硬失败。
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentDefinitionService: AgentDefinitionService,
    private readonly agentAccessService: AgentAccessService,
  ) {}

  async list(userId?: string): Promise<AgentResponseDto[]> {
    const agents = await this.prisma.agent.findMany({
      where: { visible: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: AGENT_FLOW_INCLUDE,
    });
    return this.withAccessProjection(agents, userId);
  }

  async get(id: string, userId?: string): Promise<AgentResponseDto> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: AGENT_FLOW_INCLUDE,
    });
    if (!agent) {
      throw new NotFoundException('智能体不存在');
    }
    return this.toResponse(agent, await this.loadMembershipSubject(userId));
  }

  /** 查询后台全部智能体及原始开放配置 */
  async listForAdmin(): Promise<AgentResponseDto[]> {
    const agents = await this.prisma.agent.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: AGENT_FLOW_INCLUDE,
    });
    return agents.map((agent) => this.toAdminResponse(agent));
  }

  /** 查询后台智能体详情，不受 visible 过滤 */
  async getForAdmin(id: string): Promise<AgentResponseDto> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: AGENT_FLOW_INCLUDE,
    });
    if (!agent) {
      throw new NotFoundException('智能体不存在');
    }
    return this.toAdminResponse(agent);
  }

  async create(dto: CreateAgentDto, userId: string): Promise<AgentResponseDto> {
    await this.ensurePublishedFlowVersion(dto.defaultFlowVersionId);
    const agent = await this.runSerializableTransaction(async (tx) => {
      const created = await tx.agent.create({
        include: AGENT_FLOW_INCLUDE,
        data: {
          name: dto.name,
          description: dto.description ?? '',
          avatar: dto.avatar?.trim() || null,
          systemPrompt: dto.systemPrompt ?? null,
          modelPreset: dto.modelPreset ?? null,
          defaultFlowVersionId: dto.defaultFlowVersionId ?? null,
          enabled: dto.enabled ?? true,
          visible: dto.visible ?? true,
          minimumMembershipTier:
            dto.minimumMembershipTier ?? MembershipTier.FREE,
          createdById: userId,
        },
      });
      await tx.managementAuditLog.create({
        data: {
          actorId: userId,
          targetType: ManagementAuditTargetType.AGENT,
          targetId: created.id,
          action: ManagementAuditAction.AGENT_ACCESS_UPDATED,
          after: this.accessSnapshot(created),
        },
      });
      return created;
    });
    this.agentDefinitionService.invalidate();
    return this.toResponse(agent);
  }

  async update(
    id: string,
    dto: UpdateAgentDto,
    actorId?: string,
  ): Promise<AgentResponseDto> {
    await this.ensurePublishedFlowVersion(dto.defaultFlowVersionId);
    const data = {
      name: dto.name,
      description: dto.description,
      // undefined=不改；null/空串=清空，客户端显示名称首字
      avatar: dto.avatar === undefined ? undefined : dto.avatar?.trim() || null,
      systemPrompt: dto.systemPrompt,
      modelPreset: dto.modelPreset,
      defaultFlowVersionId: dto.defaultFlowVersionId,
      enabled: dto.enabled,
      visible: dto.visible,
      minimumMembershipTier: dto.minimumMembershipTier,
    };

    if (actorId) {
      const agent = await this.runSerializableTransaction(async (tx) => {
        const currentAgent = await tx.agent.findUnique({ where: { id } });
        if (!currentAgent) {
          throw new NotFoundException('智能体不存在');
        }
        this.assertDefaultAgentUpdate(currentAgent, data);
        const updated = await tx.agent.update({
          where: { id },
          data,
          include: AGENT_FLOW_INCLUDE,
        });
        if (
          currentAgent.enabled !== updated.enabled ||
          currentAgent.visible !== updated.visible ||
          currentAgent.minimumMembershipTier !== updated.minimumMembershipTier
        ) {
          await tx.managementAuditLog.create({
            data: {
              actorId,
              targetType: ManagementAuditTargetType.AGENT,
              targetId: id,
              action: ManagementAuditAction.AGENT_ACCESS_UPDATED,
              before: this.accessSnapshot(currentAgent),
              after: this.accessSnapshot(updated),
            },
          });
        }
        return updated;
      });
      this.agentDefinitionService.invalidate();
      return this.toResponse(agent);
    }

    if (dto.enabled === false) {
      const agent = await this.runSerializableTransaction(async (tx) => {
        const currentAgent = await tx.agent.findUnique({ where: { id } });
        if (!currentAgent) {
          throw new NotFoundException('智能体不存在');
        }
        if (currentAgent.isDefault) {
          throw new BadRequestException('默认智能体不可停用');
        }
        return tx.agent.update({
          where: { id },
          data,
          include: AGENT_FLOW_INCLUDE,
        });
      });

      this.agentDefinitionService.invalidate();
      return this.toResponse(agent);
    }

    await this.ensureExists(id);
    const agent = await this.prisma.agent.update({
      where: { id },
      data,
      include: AGENT_FLOW_INCLUDE,
    });
    this.agentDefinitionService.invalidate();
    return this.toResponse(agent);
  }

  /**
   * 将指定的已启用智能体设为全局默认智能体
   * @param id 要设为默认智能体的智能体 ID
   * @returns 返回更新后的默认智能体响应数据
   * @description 先确认目标存在且已启用，再在同一事务内清除其他默认标记并设置目标标记；
   * 事务成功后失效智能体定义缓存，使未指定 agentId 的普通聊天使用新的默认智能体。
   */
  async setDefault(id: string, actorId?: string): Promise<AgentResponseDto> {
    const agent = await this.runSerializableTransaction(async (tx) => {
      const targetAgent = await tx.agent.findUnique({ where: { id } });
      if (!targetAgent) {
        throw new NotFoundException('智能体不存在');
      }
      if (!targetAgent.enabled) {
        throw new BadRequestException('停用的智能体不可设为默认');
      }
      if (targetAgent.visible === false) {
        throw new BadRequestException('隐藏的智能体不可设为默认');
      }
      if (
        targetAgent.minimumMembershipTier !== undefined &&
        targetAgent.minimumMembershipTier !== MembershipTier.FREE
      ) {
        throw new BadRequestException('默认智能体最低会员等级必须为 FREE');
      }
      const previousDefault = actorId
        ? await tx.agent.findFirst({
            where: { isDefault: true, id: { not: id } },
          })
        : null;
      await tx.agent.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
      const updated = await tx.agent.update({
        where: { id },
        data: { isDefault: true },
        include: AGENT_FLOW_INCLUDE,
      });
      if (actorId) {
        const auditWrites = [
          tx.managementAuditLog.create({
            data: {
              actorId,
              targetType: ManagementAuditTargetType.AGENT,
              targetId: id,
              action: ManagementAuditAction.AGENT_ACCESS_UPDATED,
              before: this.accessSnapshot(targetAgent),
              after: this.accessSnapshot(updated),
            },
          }),
        ];
        if (previousDefault) {
          auditWrites.push(
            tx.managementAuditLog.create({
              data: {
                actorId,
                targetType: ManagementAuditTargetType.AGENT,
                targetId: previousDefault.id,
                action: ManagementAuditAction.AGENT_ACCESS_UPDATED,
                before: this.accessSnapshot(previousDefault),
                after: this.accessSnapshot({
                  ...previousDefault,
                  isDefault: false,
                }),
              },
            }),
          );
        }
        await Promise.all(auditWrites);
      }
      return updated;
    });

    this.agentDefinitionService.invalidate();
    return this.toResponse(agent);
  }

  async remove(id: string, actorId?: string): Promise<void> {
    await this.runSerializableTransaction(async (tx) => {
      const agent = await tx.agent.findUnique({ where: { id } });
      if (!agent) {
        throw new NotFoundException('智能体不存在');
      }
      if (agent.isDefault) {
        throw new BadRequestException('默认智能体不可删除');
      }
      if (actorId) {
        await tx.managementAuditLog.create({
          data: {
            actorId,
            targetType: ManagementAuditTargetType.AGENT,
            targetId: id,
            action: ManagementAuditAction.AGENT_ACCESS_UPDATED,
            before: this.accessSnapshot(agent),
          },
        });
      }
      return tx.agent.delete({ where: { id } });
    });
    this.agentDefinitionService.invalidate();
  }

  /**
   * 在可串行化事务中执行操作，并有限重试序列化冲突
   * @param operation 接收事务客户端并执行数据库读写的异步操作
   * @returns 返回操作在成功提交后产生的结果
   * @description 使用 Serializable 隔离级别将读取决策与写入合并为原子操作；仅对可重试的
   * Prisma P2034 序列化冲突重试，达到最大次数后继续抛出原始异常。
   */
  private async runSerializableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
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

  private async ensureExists(id: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('智能体不存在');
    }
    return agent;
  }

  /**
   * 校验待绑定的默认 FlowVersion 已发布
   * @param versionId 管理端提交的 FlowVersion ID；undefined/null 表示不绑定或清除绑定
   * @returns 无返回值
   * @description Agent 只能指向不可变的 PUBLISHED 版本，避免新任务读取会被继续编辑的草稿或已归档的历史版本。
   */
  private async ensurePublishedFlowVersion(
    versionId: string | null | undefined,
  ): Promise<void> {
    if (versionId === undefined || versionId === null) {
      return;
    }
    const version = await this.prisma.agentFlowVersion.findUnique({
      where: { id: versionId },
      select: { status: true },
    });
    if (!version || version.status !== AgentFlowVersionStatus.PUBLISHED) {
      throw new BadRequestException('只能绑定已发布的 Flow 版本');
    }
  }

  private toResponse(
    agent: AgentWithFlow,
    subject?: MembershipAccessSubject,
  ): AgentResponseDto {
    const access: AgentAccessDecision = this.agentAccessService.evaluate(
      subject ?? {
        membershipTier: MembershipTier.FREE,
        membershipExpiresAt: null,
      },
      {
        enabled: agent.enabled,
        minimumMembershipTier:
          agent.minimumMembershipTier ?? MembershipTier.FREE,
      },
    );
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      avatar: agent.avatar,
      systemPrompt: agent.systemPrompt,
      modelPreset: agent.modelPreset,
      defaultFlowVersionId: agent.defaultFlowVersionId,
      toolGroups: resolveAgentToolGroups(agent.defaultFlowVersion?.definition),
      enabled: agent.enabled,
      visible: agent.visible ?? true,
      minimumMembershipTier: agent.minimumMembershipTier ?? MembershipTier.FREE,
      canUse: access.canUse,
      accessReason: access.canUse ? null : access.reason,
      requiredTier:
        !access.canUse && 'requiredTier' in access ? access.requiredTier : null,
      isDefault: agent.isDefault,
      createdAt: agent.createdAt.getTime(),
      updatedAt: agent.updatedAt.getTime(),
    };
  }

  private async loadMembershipSubject(
    userId?: string,
  ): Promise<MembershipAccessSubject | undefined> {
    if (!userId) {
      return undefined;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { membershipTier: true, membershipExpiresAt: true },
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return user;
  }

  private async withAccessProjection(
    agents: AgentWithFlow[],
    userId?: string,
  ): Promise<AgentResponseDto[]> {
    const subject = await this.loadMembershipSubject(userId);
    return agents.map((agent) => this.toResponse(agent, subject));
  }

  private toAdminResponse(agent: AgentWithFlow): AgentResponseDto {
    return this.toResponse(agent, {
      membershipTier: MembershipTier.PRO,
      membershipExpiresAt: null,
    });
  }

  private assertDefaultAgentUpdate(
    currentAgent: Agent,
    data: Prisma.AgentUpdateInput,
  ): void {
    if (!currentAgent.isDefault) {
      return;
    }
    if (data.enabled === false || data.visible === false) {
      throw new BadRequestException('默认智能体必须启用且展示');
    }
    if (
      data.minimumMembershipTier !== undefined &&
      data.minimumMembershipTier !== MembershipTier.FREE
    ) {
      throw new BadRequestException('默认智能体最低会员等级必须为 FREE');
    }
  }

  private accessSnapshot(
    agent: Pick<
      Agent,
      'enabled' | 'visible' | 'minimumMembershipTier' | 'isDefault'
    >,
  ): Prisma.JsonObject {
    return {
      enabled: agent.enabled,
      visible: agent.visible,
      minimumMembershipTier: agent.minimumMembershipTier,
      isDefault: agent.isDefault,
    };
  }
}

/**
 * 读取智能体时一并取出绑定 Flow 的 Definition
 * @description 工具组要从图上推导，逐个再查一次就是 N+1。
 */
const AGENT_FLOW_INCLUDE = {
  defaultFlowVersion: { select: { definition: true } },
} as const;

/** Agent 行加上绑定 Flow 版本的 Definition。 */
type AgentWithFlow = Agent & {
  /**
   * 绑定版本的 Definition
   * @description 刻意**不可选**：写成可选的话，忘了带 `AGENT_FLOW_INCLUDE` 的查询依然
   * 编译通过，只是运行时静默返回空工具组——那种错误要靠肉眼看界面才会发现。
   */
  defaultFlowVersion: { definition: Prisma.JsonValue } | null;
};

/**
 * 推导一个智能体可用的工具组
 * @param boundDefinition 绑定 FlowVersion 的 Definition 原文；未绑定时为空
 * @returns 返回可直接展示的工具组名
 * @description 未绑定 Flow 的智能体执行内置 direct Flow，因此这里取同一份代码预设去算，
 * 而不是写死一个空数组——内置形态哪天加了工具，展示会跟着变，不会静默漂移。
 *
 * Definition 解析失败时返回空数组：这是个纯展示字段，为了它让整个智能体列表报错不值得；
 * 真正的契约不兼容会在任务创建与画布读取时被明确拒绝。
 */
function resolveAgentToolGroups(
  boundDefinition: Prisma.JsonValue | null | undefined,
): string[] {
  if (!boundDefinition) {
    return [...collectFlowToolGroups(createFlowDefinitionPreset('direct'))];
  }
  const parsed = validateFlowDefinition(boundDefinition);
  return parsed.success ? [...collectFlowToolGroups(parsed.definition)] : [];
}
