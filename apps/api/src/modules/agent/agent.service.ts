import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { flowDefinitionUsesAgentDefault } from '@litter-bear/types/agent-flow';
import {
  AgentFlowVersionStatus,
  ManagementAuditAction,
  ManagementAuditTargetType,
  MembershipTier,
  type Agent,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveAgentToolGroups } from '../agent-flow/definition/flow-tool-groups';
import { AGENT_CONFIGURABLE_TOOL_GROUPS } from '../ai/agent-loop/capability/tool-groups';
import { normalizeFlowDefinition } from '../agent-flow/definition/flow-definition.versioning';
import { AgentDefinitionService } from './agent-definition.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import {
  AgentModelOptionsDto,
  AgentResponseDto,
} from './dto/agent-response.dto';
import {
  AgentAccessService,
  type MembershipAccessSubject,
  type AgentAccessDecision,
} from '../agent-access/agent-access.service';
import type { ReasoningSelection } from '@litter-bear/types';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import {
  parsePersistedReasoningConfig,
  parseReasoningSelection,
  toPersistedReasoningJson,
} from '../llm/dto/reasoning-selection.dto';

const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;

const MODEL_PRESET_SELECTION = {
  id: true,
  presetId: true,
  name: true,
  model: true,
  enabled: true,
  connection: {
    select: {
      providerKey: true,
      enabled: true,
    },
  },
} as const;

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
    private readonly modelRegistry: LlmModelRegistryService,
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

  /**
   * 列出指定智能体允许终端选择的可用模型
   * @param id 智能体 ID
   * @param userId 当前登录用户 ID
   * @returns 返回默认模型和不含连接凭据的安全模型选项
   * @description 使用资格与 visible 分开判断；有效 Flow 不消费 agent-default 时返回空集合。
   */
  async listModelOptions(
    id: string,
    userId: string,
  ): Promise<AgentModelOptionsDto> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: AGENT_FLOW_INCLUDE,
    });
    if (!agent) {
      throw new NotFoundException('智能体不存在');
    }
    const subject = await this.loadMembershipSubject(userId);
    const access = this.agentAccessService.evaluate(
      subject ?? {
        membershipTier: MembershipTier.FREE,
        membershipExpiresAt: null,
      },
      {
        enabled: agent.enabled,
        minimumMembershipTier: agent.minimumMembershipTier,
      },
    );
    if (!access.canUse) {
      throw new ForbiddenException('当前用户无权使用该智能体');
    }

    if (!this.usesAgentModels(agent.defaultFlowVersion?.definition)) {
      return {
        agentId: agent.id,
        defaultModelPresetId: null,
        defaultReasoning: null,
        models: [],
      };
    }

    const models = agent.allowedModelPresets
      .map((item) => item.modelPreset)
      .filter((preset) => preset.enabled && preset.connection.enabled)
      .map((preset) => ({
        modelPresetId: preset.presetId,
        name: preset.name,
        providerKey: preset.connection.providerKey,
        model: preset.model,
        reasoningCapability:
          this.modelRegistry.getReasoningCapability(preset.presetId) ?? null,
        supportsVision: Boolean(
          this.modelRegistry.getVisionTransport(preset.presetId),
        ),
      }));
    const defaultPresetId = agent.defaultModelPreset?.presetId ?? null;
    return {
      agentId: agent.id,
      defaultModelPresetId: models.some(
        (model) => model.modelPresetId === defaultPresetId,
      )
        ? defaultPresetId
        : null,
      defaultReasoning:
        parsePersistedReasoningConfig(agent.defaultReasoningConfig)
          ?.selection ?? null,
      models,
    };
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
    const agent = await this.runSerializableTransaction(async (tx) => {
      const execution = await this.resolveExecutionConfig(tx, {
        flowVersionId: dto.defaultFlowVersionId ?? null,
        allowedModelPresetIds: dto.allowedModelPresetIds ?? [],
        defaultModelPresetId: dto.defaultModelPresetId ?? null,
        defaultReasoning: parseReasoningSelection(
          dto.defaultReasoning ?? undefined,
        ),
        toolGroups: dto.toolGroups,
      });
      const created = await tx.agent.create({
        include: AGENT_FLOW_INCLUDE,
        data: {
          name: dto.name,
          description: dto.description ?? '',
          avatar: dto.avatar?.trim() || null,
          systemPrompt: dto.systemPrompt ?? null,
          ...(execution.flowVersionId
            ? {
                defaultFlowVersion: {
                  connect: { id: execution.flowVersionId },
                },
              }
            : {}),
          ...(execution.defaultModel
            ? {
                defaultModelPreset: {
                  connect: { id: execution.defaultModel.id },
                },
              }
            : {}),
          defaultReasoningConfig: execution.defaultReasoning
            ? toPersistedReasoningJson(execution.defaultReasoning)
            : Prisma.JsonNull,
          allowedModelPresets: {
            create: execution.allowedModels.map((model) => ({
              modelPresetId: model.id,
            })),
          },
          toolGroups: execution.toolGroups,
          enabled: dto.enabled ?? true,
          visible: dto.visible ?? true,
          minimumMembershipTier:
            dto.minimumMembershipTier ?? MembershipTier.FREE,
          createdBy: { connect: { id: userId } },
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
    const agent = await this.runSerializableTransaction(async (tx) => {
      const currentAgent = await tx.agent.findUnique({
        where: { id },
        include: AGENT_FLOW_INCLUDE,
      });
      if (!currentAgent) {
        throw new NotFoundException('智能体不存在');
      }
      const execution = await this.resolveExecutionConfig(tx, {
        flowVersionId:
          dto.defaultFlowVersionId === undefined
            ? currentAgent.defaultFlowVersionId
            : dto.defaultFlowVersionId,
        allowedModelPresetIds:
          dto.allowedModelPresetIds ??
          currentAgent.allowedModelPresets.map(
            (item) => item.modelPreset.presetId,
          ),
        defaultModelPresetId:
          dto.defaultModelPresetId === undefined
            ? (currentAgent.defaultModelPreset?.presetId ?? null)
            : dto.defaultModelPresetId,
        defaultReasoning:
          dto.defaultReasoning === undefined
            ? parsePersistedReasoningConfig(currentAgent.defaultReasoningConfig)
                ?.selection
            : parseReasoningSelection(dto.defaultReasoning ?? undefined),
        // 未传时沿用现值；改为绑定 Flow 而未显式传值时由校验收敛为空，不留死配置
        toolGroups:
          dto.toolGroups ??
          (dto.defaultFlowVersionId ? undefined : currentAgent.toolGroups),
      });
      const executionChanged =
        dto.defaultFlowVersionId !== undefined ||
        dto.allowedModelPresetIds !== undefined ||
        dto.defaultModelPresetId !== undefined ||
        dto.defaultReasoning !== undefined;
      const data: Prisma.AgentUpdateInput = {
        name: dto.name,
        description: dto.description,
        // undefined=不改；null/空串=清空，客户端显示名称首字
        avatar:
          dto.avatar === undefined ? undefined : dto.avatar?.trim() || null,
        systemPrompt: dto.systemPrompt,
        enabled: dto.enabled,
        visible: dto.visible,
        minimumMembershipTier: dto.minimumMembershipTier,
        ...(dto.defaultFlowVersionId !== undefined
          ? {
              defaultFlowVersion: execution.flowVersionId
                ? { connect: { id: execution.flowVersionId } }
                : { disconnect: true },
            }
          : {}),
        toolGroups: execution.toolGroups,
        ...(executionChanged
          ? {
              defaultModelPreset: execution.defaultModel
                ? { connect: { id: execution.defaultModel.id } }
                : { disconnect: true },
              allowedModelPresets: {
                deleteMany: {},
                create: execution.allowedModels.map((model) => ({
                  modelPresetId: model.id,
                })),
              },
              defaultReasoningConfig: execution.defaultReasoning
                ? toPersistedReasoningJson(execution.defaultReasoning)
                : Prisma.JsonNull,
            }
          : {}),
      };
      this.assertDefaultAgentUpdate(currentAgent, data);
      const updated = await tx.agent.update({
        where: { id },
        data,
        include: AGENT_FLOW_INCLUDE,
      });
      if (
        actorId &&
        (currentAgent.enabled !== updated.enabled ||
          currentAgent.visible !== updated.visible ||
          currentAgent.minimumMembershipTier !== updated.minimumMembershipTier)
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

  /**
   * 解析并校验智能体的执行配置
   * @param tx 当前可串行化事务客户端
   * @param input 待保存的 FlowVersion、允许模型和默认模型业务标识
   * @returns 返回可直接写入关系字段的 FlowVersion ID、默认模型和允许模型记录
   * @description 未绑定 Flow 时运行代码定义的默认 ReAct 智能体；绑定时要求版本已发布且 Definition
   * 符合当前契约。只有有效 Definition 使用 agent-default 时才允许并要求配置模型集合，且集合内
   * 每个预设及其供应商连接都必须启用。工具组只对默认助手生效：绑定 Flow 时必须为空。
   */
  private async resolveExecutionConfig(
    tx: Prisma.TransactionClient,
    input: {
      flowVersionId: string | null;
      allowedModelPresetIds: string[];
      defaultModelPresetId: string | null;
      defaultReasoning?: ReasoningSelection;
      toolGroups?: string[];
    },
  ) {
    const toolGroups = this.resolveToolGroups(
      input.flowVersionId,
      input.toolGroups,
    );
    let boundDefinition: Prisma.JsonValue | null = null;
    if (input.flowVersionId) {
      const version = await tx.agentFlowVersion.findUnique({
        where: { id: input.flowVersionId },
        select: { status: true, definition: true },
      });
      if (!version || version.status !== AgentFlowVersionStatus.PUBLISHED) {
        throw new BadRequestException('只能绑定已发布的 Flow 版本');
      }
      boundDefinition = version.definition;
    }

    if (!this.usesAgentModels(boundDefinition)) {
      if (
        input.allowedModelPresetIds.length > 0 ||
        input.defaultModelPresetId !== null ||
        input.defaultReasoning !== undefined
      ) {
        throw new BadRequestException(
          '当前 Flow 不使用 agent-default，不能配置 Agent 允许模型或默认模型',
        );
      }
      return {
        flowVersionId: input.flowVersionId,
        defaultModel: null,
        allowedModels: [],
        defaultReasoning: undefined,
        toolGroups,
      };
    }

    if (input.allowedModelPresetIds.length === 0) {
      throw new BadRequestException(
        '当前 Flow 使用 agent-default，请至少选择一个允许模型',
      );
    }
    if (!input.defaultModelPresetId) {
      throw new BadRequestException(
        '当前 Flow 使用 agent-default，请选择 Agent 默认模型',
      );
    }
    if (!input.allowedModelPresetIds.includes(input.defaultModelPresetId)) {
      throw new BadRequestException('Agent 默认模型必须属于允许模型集合');
    }

    const allowedModels = await tx.modelPreset.findMany({
      where: { presetId: { in: input.allowedModelPresetIds } },
      select: MODEL_PRESET_SELECTION,
    });
    const modelsByPresetId = new Map(
      allowedModels.map((model) => [model.presetId, model]),
    );
    const missingPresetId = input.allowedModelPresetIds.find(
      (presetId) => !modelsByPresetId.has(presetId),
    );
    if (missingPresetId) {
      throw new BadRequestException(`模型预设「${missingPresetId}」不存在`);
    }
    const orderedModels = input.allowedModelPresetIds.map((presetId) =>
      modelsByPresetId.get(presetId)!,
    );
    const unavailableModel = orderedModels.find(
      (model) => !model.enabled || !model.connection.enabled,
    );
    if (unavailableModel) {
      throw new BadRequestException(
        `模型预设「${unavailableModel.presetId}」或其供应商连接已停用`,
      );
    }

    const defaultReasoning = this.modelRegistry.normalizePresetReasoning(
      input.defaultModelPresetId,
      input.defaultReasoning,
      { applyDefault: true },
    );

    return {
      flowVersionId: input.flowVersionId,
      defaultModel: modelsByPresetId.get(input.defaultModelPresetId)!,
      allowedModels: orderedModels,
      defaultReasoning,
      toolGroups,
    };
  }

  /**
   * 校验并收敛默认助手的工具组
   * @param flowVersionId 待绑定的 FlowVersion；非空表示工具由 Flow 节点声明
   * @param toolGroups 请求中的工具组；undefined 表示未配置
   * @returns 返回去重且按闭集校验过的工具组
   * @description 绑定 Flow 时显式传入非空工具组直接拒绝——那是一个不会驱动执行的死配置。
   */
  private resolveToolGroups(
    flowVersionId: string | null,
    toolGroups: string[] | undefined,
  ): string[] {
    const groups = [...new Set(toolGroups ?? [])];
    if (flowVersionId) {
      if (groups.length > 0) {
        throw new BadRequestException(
          '绑定 Flow 的智能体工具由 Flow 节点声明，不能再配置工具组',
        );
      }
      return [];
    }
    const unknown = groups.find(
      (group) => !AGENT_CONFIGURABLE_TOOL_GROUPS.includes(group),
    );
    if (unknown) {
      throw new BadRequestException(`工具组「${unknown}」不可用于默认助手`);
    }
    return groups;
  }

  /**
   * 判断智能体是否使用自身的模型配置（允许模型集合与默认模型）
   * @param boundDefinition 已绑定发布版本的 Definition；为空表示运行代码定义的默认 ReAct 智能体
   * @returns 默认智能体恒为 true；绑定 Flow 时取决于图上是否有 agent-default 节点
   * @description 损坏或旧版本工件会明确报错，避免向终端返回一套实际无法执行的模型选项。
   */
  private usesAgentModels(
    boundDefinition: Prisma.JsonValue | null | undefined,
  ): boolean {
    if (!boundDefinition) {
      return true;
    }
    const parsed = normalizeFlowDefinition(boundDefinition);
    if (!parsed.success) {
      throw new BadRequestException(
        `智能体绑定的 Flow 版本无法升级或定义无效：${parsed.inspection.errors[0]?.message ?? 'Definition 无效'}`,
      );
    }
    return flowDefinitionUsesAgentDefault(parsed.definition);
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
      defaultModelPresetId: agent.defaultModelPreset?.presetId ?? null,
      defaultReasoning:
        parsePersistedReasoningConfig(agent.defaultReasoningConfig)
          ?.selection ?? null,
      allowedModelPresetIds: agent.allowedModelPresets.map(
        (item) => item.modelPreset.presetId,
      ),
      defaultFlowVersionId: agent.defaultFlowVersionId,
      toolGroups: resolveAgentToolGroups(agent),
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
  defaultModelPreset: { select: { presetId: true } },
  allowedModelPresets: {
    orderBy: { createdAt: 'asc' },
    select: { modelPreset: { select: MODEL_PRESET_SELECTION } },
  },
} as const;

/** Agent 行加上绑定 Flow 版本的 Definition。 */
type AgentWithFlow = Prisma.AgentGetPayload<{
  include: typeof AGENT_FLOW_INCLUDE;
}>;
