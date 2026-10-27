import { BadRequestException, Injectable } from '@nestjs/common';
import {
  flowDefinitionUsesAgentDefault,
  type FlowDefinition,
} from '@litter-bear/types/agent-flow';
import {
  AgentFlowVersionStatus,
  Prisma,
  StreamTaskRuntime,
} from '@prisma/client';
import { normalizeFlowDefinition } from '../agent-flow/definition/flow-definition.versioning';
import { TemporalClientService } from '../agent-flow/temporal/temporal-client.service';
import { DEFAULT_CHAT_AGENT_NODE_KEY } from '../chat-agent/default-chat-agent.constants';
import { FlowRuntimeValidator } from '../agent-flow/runtime/flow-runtime-validator.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { ReasoningSelection } from '@litter-bear/types';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import {
  parsePersistedReasoningConfig,
  toPersistedReasoningJson,
} from '../llm/dto/reasoning-selection.dto';

/** 两种运行时共有、写入 StreamTask 的任务快照字段。 */
interface TaskSnapshotBase {
  currentStep: string;
  /**
   * 本轮实际执行的 Agent
   * @description 必须一并写进 StreamTask：Activity 要靠 `task.agentId` 读模型与人设，
   * 缺了就抛 AGENT_FLOW_TASK_SNAPSHOT_MISMATCH。
   *
   * 没有指定 Agent 时这里是回落到的 `isDefault` Agent。只在解析时用它、不写回任务的话，
   * 派发用的是它的模型、执行时却发现任务上没有 Agent——历史上没有 defaultAgentId 的
   * 会话就是这样失败的。
   */
  agentId: string;
  /** 与默认模型同时解析并冻结的本轮思考选择。 */
  resolvedAgentReasoningConfig: Prisma.InputJsonValue | typeof Prisma.JsonNull;
}

/** 绑定了 Flow 的智能体：由 agentFlowWorkflow 执行已发布版本。 */
export interface AgentFlowTaskSnapshot extends TaskSnapshotBase {
  runtime: typeof StreamTaskRuntime.AGENT_FLOW;
  flowVersionId: string;
  flowDigest: string;
  /** 本轮 agent-default 解析后的稳定模型预设业务标识；Flow 不用 agent-default 时为 null。 */
  resolvedAgentModelPresetId: string | null;
}

/** 未绑定 Flow 的智能体：由代码定义的默认 ReAct 智能体执行。 */
export interface ChatAgentTaskSnapshot extends TaskSnapshotBase {
  runtime: typeof StreamTaskRuntime.CHAT_AGENT;
  resolvedAgentModelPresetId: string;
  /** 本轮实际启用的工具组；模型未通过工具探测时为空。 */
  resolvedAgentToolGroups: string[];
  /** 智能体配置了工具、但因模型能力被降级为纯问答。 */
  agentToolsDegraded: boolean;
}

/** 已冻结到 StreamTask 的执行快照。 */
export type TaskExecutionSnapshot =
  AgentFlowTaskSnapshot | ChatAgentTaskSnapshot;

/** 派发一个已冻结任务所需的最小持久化字段。 */
export interface TaskDispatchInput {
  taskId: string;
  runtime: StreamTaskRuntime;
  flowVersionId: string | null;
  flowDigest: string | null;
  temporalWorkflowId: string | null;
  temporalRunId: string | null;
}

/** 已成功启动的 Temporal Workflow 标识。 */
export interface FlowTaskDispatchResult {
  workflowId: string;
  runId: string;
}

/**
 * 任务派发器
 * @description 在 StreamTask 与 Temporal Workflow 之间提供唯一的派发 seam：事务内锁定不可变执行快照，事务提交后幂等启动 Workflow 并回写 Temporal 执行标识。它不执行业务节点、不写 SSE 帧，也不进入旧的进程内 Agent producer。
 */
@Injectable()
export class FlowTaskDispatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temporalClientService: TemporalClientService,
    private readonly runtimeValidator: FlowRuntimeValidator,
    private readonly modelRegistry: LlmModelRegistryService,
  ) {}

  /**
   * 解析任务应锁定的执行快照
   * @param tx 当前创建 StreamTask 所在的 Prisma 事务客户端
   * @param input 包含回答 Agent 与本轮可选模型的任务创建上下文
   * @returns 返回可写入 StreamTask 的执行快照；找不到可用 Agent 时抛错
   * @description Agent 绑定了 Flow 就锁定那个已发布版本，交给 agentFlowWorkflow；没绑定就交给代码定义的
   * 默认 ReAct 智能体，锁定模型、思考与工具组。
   *
   * 没有指定 Agent 时回落到 `isDefault` 的 Agent：两条运行时都需要一个具体的模型来源，
   * 而"没有 Agent"提供不了。
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
  ): Promise<TaskExecutionSnapshot> {
    const agentSelect = {
      defaultModelPreset: { select: { presetId: true } },
      defaultReasoningConfig: true,
      toolGroups: true,
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
    const agentModels = {
      selectedModelPresetId: input.selectedModelPresetId,
      defaultModelPresetId: agent.defaultModelPreset?.presetId ?? null,
      allowedModels: agent.allowedModelPresets.map((item) => item.modelPreset),
    };
    const agentReasoning = {
      selectedModelPresetId: input.selectedModelPresetId,
      reasoning: input.reasoning,
      defaultModelPresetId: agent.defaultModelPreset?.presetId ?? null,
      defaultReasoning: parsePersistedReasoningConfig(
        agent.defaultReasoningConfig,
      )?.selection,
    };

    const flowVersion = agent.defaultFlowVersion;
    if (!flowVersion) {
      return this.resolveChatAgentSnapshot({
        agentId: agent.id,
        toolGroups: agent.toolGroups,
        requiresVision: Boolean(input.requiresVision),
        models: agentModels,
        reasoning: agentReasoning,
      });
    }
    if (
      flowVersion.status !== AgentFlowVersionStatus.PUBLISHED ||
      !flowVersion.digest
    ) {
      throw new BadRequestException(
        '智能体绑定的 FlowVersion 未发布或缺少摘要',
      );
    }

    const parsed = normalizeFlowDefinition(flowVersion.definition);
    if (!parsed.success) {
      throw new BadRequestException({
        message: '智能体绑定的 FlowVersion 无法升级或定义无效',
        errors: parsed.inspection.errors,
      });
    }
    if (parsed.sourceDigest !== flowVersion.digest) {
      throw new BadRequestException(
        '智能体绑定的 FlowVersion 摘要与 Definition 不一致',
      );
    }
    const entryNodeIds = new Set(
      parsed.definition.edges.map((edge) => edge.to),
    );
    const entryNode = parsed.definition.nodes.find(
      (node) => !entryNodeIds.has(node.id),
    );
    if (!entryNode) {
      throw new BadRequestException('智能体绑定的 FlowVersion 缺少入口节点');
    }

    const usesAgentDefault = flowDefinitionUsesAgentDefault(parsed.definition);
    if (!usesAgentDefault) {
      if (input.selectedModelPresetId) {
        throw new BadRequestException(
          '当前 Flow 不使用 agent-default，不能为本轮选择模型',
        );
      }
      if (input.reasoning !== undefined) {
        throw new BadRequestException(
          '当前智能体使用自定义 Flow，不能为本轮覆盖思考参数',
        );
      }
    }
    const resolvedAgentModelPresetId = usesAgentDefault
      ? this.resolveAgentDefaultModel(agentModels)
      : null;
    const resolvedReasoning = resolvedAgentModelPresetId
      ? this.resolveAgentDefaultReasoning({
          ...agentReasoning,
          resolvedModelPresetId: resolvedAgentModelPresetId,
        })
      : undefined;

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
        message: `智能体绑定的 Flow 在当前配置下无法运行：${[
          ...new Set(runtime.errors.map((error) => error.message)),
        ].join('；')}`,
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
      runtime: StreamTaskRuntime.AGENT_FLOW,
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
   * 为未绑定 Flow 的智能体锁定默认 ReAct 智能体的执行快照
   * @param input Agent 标识、配置的工具组、图片需求与模型/思考解析上下文
   * @returns 返回 CHAT_AGENT 快照
   * @description 模型、思考与工具组在这里一次性冻结，重试与审批恢复只读快照，不受 Agent 后续修改影响。
   * 模型未通过工具往返探测时不拒绝任务，而是锁空工具组并标记降级：回答仍能给出，节点摘要会说明本轮没有工具。
   * 图片任务直接检查锁定模型的视觉能力，不支持就在创建时拒绝，而不是派发后才失败。
   */
  private resolveChatAgentSnapshot(input: {
    agentId: string;
    toolGroups: readonly string[];
    requiresVision: boolean;
    models: Parameters<
      FlowTaskDispatcherService['resolveAgentDefaultModel']
    >[0];
    reasoning: Omit<
      Parameters<FlowTaskDispatcherService['resolveAgentDefaultReasoning']>[0],
      'resolvedModelPresetId'
    >;
  }): ChatAgentTaskSnapshot {
    const modelPresetId = this.resolveAgentDefaultModel(input.models);
    const reasoning = this.resolveAgentDefaultReasoning({
      ...input.reasoning,
      resolvedModelPresetId: modelPresetId,
    });
    if (
      input.requiresVision &&
      !this.modelRegistry.getVisionTransport(modelPresetId)
    ) {
      throw new BadRequestException(
        `模型「${modelPresetId}」不支持图片输入，请切换模型后重试`,
      );
    }
    const toolsAllowed =
      this.modelRegistry.getCapability(modelPresetId) === 'tools';
    return {
      runtime: StreamTaskRuntime.CHAT_AGENT,
      currentStep: DEFAULT_CHAT_AGENT_NODE_KEY,
      agentId: input.agentId,
      resolvedAgentModelPresetId: modelPresetId,
      resolvedAgentReasoningConfig: reasoning
        ? toPersistedReasoningJson(reasoning)
        : Prisma.JsonNull,
      resolvedAgentToolGroups: toolsAllowed ? [...input.toolGroups] : [],
      agentToolsDegraded: !toolsAllowed && input.toolGroups.length > 0,
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

  /** 解析本轮最终思考选择：请求覆盖优先，未覆盖且用默认模型时沿用 Agent 默认思考。 */
  private resolveAgentDefaultReasoning(input: {
    selectedModelPresetId?: string;
    reasoning?: ReasoningSelection;
    resolvedModelPresetId: string;
    defaultModelPresetId: string | null;
    defaultReasoning?: ReasoningSelection;
  }): ReasoningSelection | undefined {
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
   * 解析本轮 Agent 默认模型对应的实际模型
   * @param input 终端选择、Agent 默认值与允许模型状态
   * @returns 返回锁定到 StreamTask 的模型预设业务标识
   * @description 终端选择必须属于 Agent 允许集合。默认模型也必须属于集合；目标预设或供应商连接
   * 停用时明确拒绝，不回退系统默认模型或集合第一项。
   */
  private resolveAgentDefaultModel(input: {
    selectedModelPresetId?: string;
    defaultModelPresetId: string | null;
    allowedModels: readonly {
      presetId: string;
      enabled: boolean;
      connection: { enabled: boolean };
    }[];
  }): string {
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
   * 幂等派发一个已冻结的任务
   * @param input StreamTask 的运行时快照与已持久化 Temporal 标识
   * @returns 返回首次启动的 Workflow 标识；已保存标识的任务返回 null
   * @description Temporal Workflow ID 固定使用 StreamTask ID。仅在任务尚未保存 Workflow 标识时调用 Temporal；成功启动后立即回写 workflowId 与 runId，使 HTTP/SSE 进程后续只负责订阅和回放。
   */
  async dispatch(
    input: TaskDispatchInput,
  ): Promise<FlowTaskDispatchResult | null> {
    if (input.temporalWorkflowId || input.temporalRunId) {
      return null;
    }

    let workflow: FlowTaskDispatchResult;
    if (input.runtime === StreamTaskRuntime.CHAT_AGENT) {
      workflow = await this.temporalClientService.startChatAgentWorkflow({
        streamTaskId: input.taskId,
      });
    } else {
      if (!input.flowVersionId || !input.flowDigest) {
        throw new BadRequestException('Flow 任务缺少锁定的 FlowVersion');
      }
      workflow = await this.temporalClientService.startWorkflow({
        streamTaskId: input.taskId,
        flowVersionId: input.flowVersionId,
        flowDigest: input.flowDigest,
      });
    }
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
