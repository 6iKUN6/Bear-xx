import { BadRequestException, Injectable } from '@nestjs/common';
import {
  flowDefinitionUsesAgentDefault,
  type FlowDefinition,
} from '@litter-bear/types/agent-flow';
import { AgentFlowVersionStatus, Prisma } from '@prisma/client';
import { normalizeFlowDefinition } from '../agent-flow/definition/flow-definition.versioning';
import { TemporalClientService } from '../agent-flow/temporal/temporal-client.service';
import { BuiltinFlowService } from '../agent-flow/builtin-flow.service';
import { FlowRuntimeValidator } from '../agent-flow/runtime/flow-runtime-validator.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { ReasoningSelection } from '@litter-bear/types';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import {
  parsePersistedReasoningConfig,
  toPersistedReasoningJson,
} from '../llm/dto/reasoning-selection.dto';

/** 已冻结到 StreamTask 的 Flow 任务快照。 */
export interface FlowTaskSnapshot {
  flowVersionId: string;
  flowDigest: string;
  currentStep: string;
  /**
   * 本轮实际执行的 Agent
   * @description 必须一并写进 StreamTask：Activity 的 `loadExecutionContext` 要靠
   * `task.agentId` 读模型与人设，缺了就抛 AGENT_FLOW_TASK_SNAPSHOT_MISMATCH。
   *
   * 没有指定 Agent 时这里是回落到的 `isDefault` Agent。只在解析时用它、不写回任务的话，
   * 派发用的是它的模型、执行时却发现任务上没有 Agent——历史上没有 defaultAgentId 的
   * 会话就是这样失败的。
   */
  agentId: string;
  /** 本轮 agent-default 解析后的稳定模型预设业务标识。 */
  resolvedAgentModelPresetId: string | null;
  /** 与默认模型同时解析并冻结的本轮思考选择。 */
  resolvedAgentReasoningConfig: Prisma.InputJsonValue | typeof Prisma.JsonNull;
}

/** 派发一个已冻结 Flow 任务所需的最小持久化字段。 */
export interface FlowTaskDispatchInput {
  taskId: string;
  flowVersionId: string;
  flowDigest: string;
  temporalWorkflowId: string | null;
  temporalRunId: string | null;
}

/** 已成功启动的 Temporal Workflow 标识。 */
export interface FlowTaskDispatchResult {
  workflowId: string;
  runId: string;
}

/**
 * Flow 任务派发器
 * @description 在 StreamTask 与 Temporal Workflow 之间提供唯一的派发 seam：事务内锁定不可变 Flow 快照，事务提交后幂等启动 Workflow 并回写 Temporal 执行标识。它不执行业务节点、不写 SSE 帧，也不进入旧的进程内 Agent producer。
 */
@Injectable()
export class FlowTaskDispatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temporalClientService: TemporalClientService,
    private readonly runtimeValidator: FlowRuntimeValidator,
    private readonly builtinFlow: BuiltinFlowService,
    private readonly modelRegistry: LlmModelRegistryService,
  ) {}

  /**
   * 解析任务应锁定的已发布 Flow 快照
   * @param tx 当前创建 StreamTask 所在的 Prisma 事务客户端
   * @param input 包含回答 Agent 与本轮可选模型的任务创建上下文
   * @returns 返回可写入 StreamTask 的 Flow 快照；找不到可用 Agent 时抛错
   * @description **Flow 是唯一编排路径**：所有聊天都从这里取图，不再有「绑了 Flow 才走 Flow」
   * 的分叉。Agent 绑没绑 Flow 只决定用哪张图——绑了用它的，没绑用内置直接回复 Flow。
   *
   * 没有指定 Agent 时回落到 `isDefault` 的 Agent：内置 Flow 里的 `agent-default` 需要一个
   * 具体的模型来源，而"没有 Agent"提供不了。
   *
   * 找不到可用 Agent 时**明确失败**，不返回 null。返回 null 会让任务落回已被废弃的旧编排
   * 链路，那是一条不可达的路；而"系统一个可用智能体都没有"本就是必须立刻发现的配置事故，
   * 不该被一句含糊的回复盖住。
   *
   * 查询与校验都在创建 StreamTask 的同一事务内，防止任务后续读到 Agent 改绑后的 FlowVersion。
   */
  async resolveTaskFlowSnapshot(
    tx: Prisma.TransactionClient,
    input: {
      agentId?: string;
      selectedModelPresetId?: string;
      reasoning?: ReasoningSelection;
      requiresVision?: boolean;
    },
  ): Promise<FlowTaskSnapshot> {
    const agentSelect = {
      defaultModelPreset: { select: { presetId: true } },
      defaultReasoningConfig: true,
      allowedModelPresets: {
        select: {
          modelPreset: {
            select: {
              presetId: true,
              enabled: true,
              connection: { select: { enabled: true } },
            },
          },
        },
      },
      defaultFlowVersion: {
        select: {
          id: true,
          digest: true,
          status: true,
          definition: true,
        },
      },
    } as const;
    const agent = input.agentId
      ? await tx.agent.findUnique({
          where: { id: input.agentId },
          select: { id: true, ...agentSelect },
        })
      : await tx.agent.findFirst({
          where: { isDefault: true, enabled: true },
          select: { id: true, ...agentSelect },
        });
    if (!agent) {
      // 明确失败而不是返回 null：返回 null 会让任务落回已被删除的旧编排链路，那是一条
      // 不存在的路；而「系统一个可用智能体都没有」本就是必须立刻发现的配置事故
      throw new BadRequestException(
        input.agentId
          ? '指定的智能体不存在或已停用'
          : '系统未配置可用的默认智能体，请先在后台启用一个',
      );
    }
    const bound = agent.defaultFlowVersion;
    const flowVersion = bound ?? (await this.builtinFlow.findDirectVersion(tx));
    if (!flowVersion) {
      // 内置 Flow 由启动时 ensure 建立；拿不到说明那一步失败了。静默回落旧链路会让
      // 这个故障一直不被发现，而用户拿到的是一条没人知道走了哪套编排的回复。
      throw new BadRequestException('内置 Flow 尚未初始化，请检查服务启动日志');
    }
    const source = bound ? '智能体绑定的' : '内置';
    if (
      flowVersion.status !== AgentFlowVersionStatus.PUBLISHED ||
      !flowVersion.digest
    ) {
      throw new BadRequestException(`${source} FlowVersion 未发布或缺少摘要`);
    }

    const parsed = normalizeFlowDefinition(flowVersion.definition);
    if (!parsed.success) {
      throw new BadRequestException({
        message: `${source} FlowVersion 无法升级或定义无效`,
        errors: parsed.inspection.errors,
      });
    }
    if (parsed.sourceDigest !== flowVersion.digest) {
      throw new BadRequestException(
        `${source} FlowVersion 摘要与 Definition 不一致`,
      );
    }
    const entryNodeIds = new Set(
      parsed.definition.edges.map((edge) => edge.to),
    );
    const entryNode = parsed.definition.nodes.find(
      (node) => !entryNodeIds.has(node.id),
    );
    if (!entryNode) {
      throw new BadRequestException(`${source} FlowVersion 缺少入口节点`);
    }

    const resolvedAgentModelPresetId = this.resolveAgentDefaultModel({
      definition: parsed.definition,
      selectedModelPresetId: input.selectedModelPresetId,
      defaultModelPresetId: agent.defaultModelPreset?.presetId ?? null,
      allowedModels: agent.allowedModelPresets.map((item) => item.modelPreset),
    });
    const resolvedReasoning = this.resolveAgentDefaultReasoning({
      definition: parsed.definition,
      selectedModelPresetId: input.selectedModelPresetId,
      reasoning: input.reasoning,
      resolvedModelPresetId: resolvedAgentModelPresetId,
      defaultModelPresetId: agent.defaultModelPreset?.presetId ?? null,
      defaultReasoning: parsePersistedReasoningConfig(
        agent.defaultReasoningConfig,
      )?.selection,
    });

    // 任务锁定期校验：节点上的 `agent-default` 到这一刻才能解析成具体预设。
    // 不在这里拦，任务会被派发出去、在 Temporal Activity 里以
    // AGENT_FLOW_RUNTIME_CONTEXT_INVALID 失败，用户只看到一句「流程执行失败」，
    // 真实原因只能翻 worker 日志——错误必须还给发起者。
    const runtime = this.runtimeValidator.validate(parsed.definition, {
      phase: 'task',
      agentDefaultModelPreset: resolvedAgentModelPresetId,
      agentDefaultReasoning: resolvedReasoning,
    });
    if (!runtime.valid) {
      throw new BadRequestException({
        message: `${source} Flow 在当前配置下无法运行`,
        errors: runtime.errors,
      });
    }
    if (input.requiresVision) {
      this.assertVisionAnswerModels(
        parsed.definition,
        resolvedAgentModelPresetId,
      );
    }

    return {
      flowVersionId: flowVersion.id,
      flowDigest: flowVersion.digest,
      currentStep: entryNode.id,
      agentId: agent.id,
      resolvedAgentModelPresetId,
      resolvedAgentReasoningConfig: resolvedReasoning
        ? toPersistedReasoningJson(resolvedReasoning)
        : Prisma.JsonNull,
    };
  }

  /**
   * 校验所有可能产出最终正文的节点都支持视觉输入。
   * @param definition 当前任务冻结的 Flow Definition
   * @param agentDefaultModelPresetId 本轮已解析的 agent-default 预设
   * @returns 无返回值；存在非视觉回答节点时拒绝创建任务
   * @description 条件分支可能有多个互斥回答节点，任务创建时无法预知最终分支，因此必须全部
   * 通过视觉闭集。只检查直接连接 end 的 agent/synthesize，与 Activity 的正文生产者判据一致。
   */
  private assertVisionAnswerModels(
    definition: FlowDefinition,
    agentDefaultModelPresetId: string | null,
  ): void {
    const endIds = new Set(
      definition.nodes
        .filter((node) => node.type === 'end')
        .map((node) => node.id),
    );
    const answerIds = new Set(
      definition.edges
        .filter((edge) => endIds.has(edge.to))
        .map((edge) => edge.from),
    );
    for (const node of definition.nodes) {
      if (
        !answerIds.has(node.id) ||
        (node.type !== 'agent' && node.type !== 'synthesize')
      ) {
        continue;
      }
      const configured = node.config.modelPreset;
      const presetId =
        !configured || configured === 'agent-default'
          ? agentDefaultModelPresetId
          : configured;
      if (!presetId || !this.modelRegistry.getVisionTransport(presetId)) {
        throw new BadRequestException(
          `回答节点「${node.name ?? node.id}」使用的模型不支持图片输入`,
        );
      }
    }
  }

  /** 解析 direct Agent 本轮最终思考选择，自定义 Flow 禁止请求级覆盖。 */
  private resolveAgentDefaultReasoning(input: {
    definition: Parameters<typeof flowDefinitionUsesAgentDefault>[0];
    selectedModelPresetId?: string;
    reasoning?: ReasoningSelection;
    resolvedModelPresetId: string | null;
    defaultModelPresetId: string | null;
    defaultReasoning?: ReasoningSelection;
  }): ReasoningSelection | undefined {
    if (!flowDefinitionUsesAgentDefault(input.definition)) {
      if (input.reasoning !== undefined) {
        throw new BadRequestException(
          '当前智能体使用自定义 Flow，不能为本轮覆盖思考参数',
        );
      }
      return undefined;
    }
    if (!input.resolvedModelPresetId) {
      return undefined;
    }
    const requested =
      input.reasoning ??
      (input.resolvedModelPresetId === input.defaultModelPresetId
        ? input.defaultReasoning
        : undefined);
    return this.modelRegistry.normalizePresetReasoning(
      input.resolvedModelPresetId,
      requested,
      { applyDefault: true },
    );
  }

  /**
   * 解析本轮 agent-default 对应的实际模型
   * @param input 当前 Definition、终端选择、Agent 默认值与允许模型状态
   * @returns 返回锁定到 StreamTask 的模型预设业务标识；Flow 不使用 agent-default 时返回 null
   * @description 终端选择只允许替换 agent-default，且必须属于 Agent 允许集合。默认模型也必须
   * 属于集合；目标预设或供应商连接停用时明确拒绝，不回退系统默认模型或集合第一项。
   */
  private resolveAgentDefaultModel(input: {
    definition: Parameters<typeof flowDefinitionUsesAgentDefault>[0];
    selectedModelPresetId?: string;
    defaultModelPresetId: string | null;
    allowedModels: readonly {
      presetId: string;
      enabled: boolean;
      connection: { enabled: boolean };
    }[];
  }): string | null {
    if (!flowDefinitionUsesAgentDefault(input.definition)) {
      if (input.selectedModelPresetId) {
        throw new BadRequestException(
          '当前 Flow 不使用 agent-default，不能为本轮选择模型',
        );
      }
      return null;
    }

    const resolved = input.selectedModelPresetId ?? input.defaultModelPresetId;
    if (!resolved) {
      throw new BadRequestException('当前智能体尚未配置默认模型');
    }
    const allowed = input.allowedModels.find(
      (model) => model.presetId === resolved,
    );
    if (!allowed) {
      throw new BadRequestException(
        input.selectedModelPresetId
          ? '本轮选择的模型不在当前智能体允许集合中'
          : '当前智能体默认模型不在允许集合中',
      );
    }
    if (!allowed.enabled || !allowed.connection.enabled) {
      throw new BadRequestException(
        `模型预设「${resolved}」或其供应商连接已停用`,
      );
    }
    return resolved;
  }

  /**
   * 幂等派发一个已冻结的 Flow 任务
   * @param input StreamTask 的 Flow 快照与已持久化 Temporal 标识
   * @returns 返回首次启动的 Workflow 标识；已保存标识的任务返回 null
   * @description Temporal Workflow ID 固定使用 StreamTask ID。仅在任务尚未保存 Workflow 标识时调用 Temporal；成功启动后立即回写 workflowId 与 runId，使 HTTP/SSE 进程后续只负责订阅和回放。
   */
  async dispatch(
    input: FlowTaskDispatchInput,
  ): Promise<FlowTaskDispatchResult | null> {
    if (input.temporalWorkflowId || input.temporalRunId) {
      return null;
    }

    const workflow = await this.temporalClientService.startWorkflow({
      streamTaskId: input.taskId,
      flowVersionId: input.flowVersionId,
      flowDigest: input.flowDigest,
    });
    await this.prisma.streamTask.update({
      where: { id: input.taskId },
      data: {
        temporalWorkflowId: workflow.workflowId,
        temporalRunId: workflow.runId,
      },
    });
    return workflow;
  }
}
