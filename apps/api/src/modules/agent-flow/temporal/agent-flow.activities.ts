import { Inject, Injectable } from '@nestjs/common';
import {
  AgentFlowApprovalKind,
  AgentFlowApprovalStatus,
  AgentFlowNodeExecutionResultKind,
  ConversationTraceItemStatus,
  MessageStatus,
  Prisma,
  StreamTaskRunStatus,
  StreamTaskStatus,
} from '@prisma/client';
import { ApplicationFailure } from '@temporalio/client';
import { z } from 'zod';
import { parsePersistedReasoningConfig } from '../../llm/dto/reasoning-selection.dto';
import {
  FLOW_CONDITION_ELSE_BRANCH,
  FLOW_LOOP_AGAIN_BRANCH,
  FLOW_LOOP_DONE_BRANCH,
  flowDefinitionUsesAgentDefault,
  flowLoopRegions,
  flowNodeBranchKeys,
  type FlowConditionCase,
  type FlowRef,
  type FlowConditionPredicate,
  type FlowDefinition,
  type FlowNodeType,
} from '@litter-bear/types/agent-flow';
import {
  AgentStrategyMode,
  StreamTaskEventType,
  TASK_ERROR_CATEGORY_LABELS,
  type ApprovalDecision,
  type ApprovalRequiredPayload,
  type PlanReviewDecision,
  type TaskErrorCategory,
} from '@litter-bear/types/protocol';
import {
  classifyLlmError,
  isRetryableTaskErrorCategory,
} from '../../llm/llm-error';
import { chatAgentCommonPrompt, planReviewGatePrompt } from '../../../prompts';
import { PrismaService } from '../../../prisma/prisma.service';
import { CapabilityResolver } from '../../ai/agent-loop/capability/capability.resolver';
import type {
  AgentLoopInput,
  AgentStrategyDecision,
} from '../../ai/agent-loop/agent-loop.types';
import { CommonChatAgentService } from '../../ai/agents';
import type { CommonChatAgentStreamEvent } from '../../ai/agents/common-chat-agent/common-chat-agent.types';
import {
  buildStepPrompt,
  buildSynthesisPrompt,
} from '../../ai/agent-loop/execution/plan-prompt.builder';
import { PlannerService } from '../../ai/agent-loop/execution/planner.service';
import { LlmService } from '../../llm/llm.service';
import { LlmModelRegistryService } from '../../llm/llm-model-registry.service';
import type { LlmMessage } from '../../llm/llm.types';
import type { ModelContextEnvelope } from '../../llm/model-context.schema';
import {
  STEP_EVALUATOR,
  type StepEvaluator,
} from '../../ai/agent-loop/execution/step-evaluator';
import type {
  AgentPlan,
  PlanStep,
} from '../../ai/agent-loop/execution/plan.types';
import { ChatContextService } from '../../memory/chat-context.service';
import { AgentFlowTaskEventService } from '../agent-flow-task-event.service';
import type { PersistedAgentFlowTaskEvent } from '../agent-flow-task-event.service';
import { StorageAssetService } from '../../storage/storage-asset.service';
import { validateFlowDefinition } from '../definition/flow-definition.validator';
import { FlowCompiler } from '../runtime/flow-compiler.service';
import type {
  CompiledAgentFlowNode,
  CompiledConditionFlowNode,
  CompiledFlowNode,
  CompiledFlowPlan,
  CompiledLoopFlowNode,
} from '../runtime/flow-runtime.types';
import type {
  AgentFlowActivityApi,
  AgentFlowFinalizeRunInput,
  AgentFlowNodeCompletedResult,
  AgentFlowNodeExecutionInput,
  AgentFlowNodeExecutionResult,
  AgentFlowNodeResumeInput,
  AgentFlowRunSnapshot,
  AgentFlowWorkflowInput,
} from '../../../temporal/workflows/agent-flow.workflow.types';

const FLOW_APPROVAL_TIMEOUT_SECONDS = 900;
/** Flow 内由 LangChain 消费的单次模型请求边界；失败不再叠加 Temporal 整节点重试。 */
const AGENT_FLOW_MODEL_RUNTIME = {
  maxRetries: 1,
  timeoutMs: 25000,
} as const;

/**
 * 计划审批门禁的结构化输出闭集
 * @description 只接受这两个字段。模型给出别的形状时 generateStructured 返回 null，
 * 调用方按「需要人工确认」闭合处理。
 */
const planReviewGateSchema = z.object({
  needsReview: z.boolean(),
  reason: z.string(),
});

/**
 * 把不可信字符串收窄为协议错误类别
 * @param value 来自数据库 JSON 的候选值
 * @returns 落在闭集内时返回该类别，否则返回 undefined
 * @description 成员判断直接借 TASK_ERROR_CATEGORY_LABELS 的键：它是
 * `Record<TaskErrorCategory, string>`，新增类别时编译器会强制补文案，
 * 因此不需要再维护第二份类别清单去和它对齐。
 */
function toTaskErrorCategory(
  value: string | undefined,
): TaskErrorCategory | undefined {
  if (value && Object.hasOwn(TASK_ERROR_CATEGORY_LABELS, value)) {
    return value as TaskErrorCategory;
  }
  return undefined;
}

/** 审批节点自己的轮次状态；steps 是本轮待审计划（可能是打回后重新生成的）。 */
interface ApprovalScratch {
  [key: string]: unknown;
  revision: number;
  feedback: string[];
  steps?: PlanStep[];
}

/** Flow PlanLoop 节点写入的可恢复步骤进度。 */
interface PersistedFlowPlanLoop {
  [key: string]: unknown;
  stepIndex: number;
  observations: string[];
  lastStepHadToolCalls: boolean;
}

/**
 * Flow 运行至今的预算用量
 * @description 跨节点、跨 Activity retry、跨 HITL 恢复累计，因此必须落库；放在内存里会让
 * 每次 Activity 重试都把预算清零，护栏形同虚设。存 StreamTask 的整数列而不是 executionState
 * JSON：JSON 只能整块读改写，两个并发节点会互相吞掉计数，等于无限预算。
 */
interface PersistedFlowBudgetUsage {
  modelCalls: number;
  toolCalls: number;
}

interface AgentFlowExecutionContext {
  task: {
    id: string;
    userId: string;
    status: StreamTaskStatus;
    conversationId: string;
    messageId: string;
    streamId: string | null;
    agentId: string;
    fullContent: string;
    budgetUsage: PersistedFlowBudgetUsage;
    /** Flow 级根变量 `$input.text`：本轮用户消息正文，供条件判定引用 */
    inputText: string;
    imageAssetId?: string;
    flowVersionId: string;
    flowDigest: string;
  };
  flowId: string;
  definition: FlowDefinition;
  compiledPlan: CompiledFlowPlan;
  node: CompiledFlowNode;
  agentSystemPrompt: string | null;
  mcdonaldsCredentialId?: string;
}

/**
 * AgentFlow 的 Temporal Activity 实现
 * @description 仅在独立 Activity Worker 中访问 Prisma、Redis 帧投影、LLM 和能力注册表。Workflow 只保留脱敏的推进快照，实际节点输入、工具调用、审批决定与完整回复始终留在业务库和 Activity 进程。
 */
@Injectable()
export class AgentFlowActivities implements AgentFlowActivityApi {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flowCompiler: FlowCompiler,
    private readonly capabilityResolver: CapabilityResolver,
    private readonly chatContextService: ChatContextService,
    private readonly commonChatAgentService: CommonChatAgentService,
    private readonly planner: PlannerService,
    @Inject(STEP_EVALUATOR) private readonly stepEvaluator: StepEvaluator,
    private readonly taskEventService: AgentFlowTaskEventService,
    private readonly llmService: LlmService,
    private readonly modelRegistry: LlmModelRegistryService,
    private readonly storageAssetService: StorageAssetService,
  ) {}

  /**
   * 返回可注册给 Temporal Activity Worker 的绑定方法集合
   * @returns 返回所有 Activity 的稳定函数映射
   * @description 绑定 this，保证 Temporal Worker 以普通函数调用 Activity 时仍能使用 Nest 注入的业务服务。
   */
  getActivityHandlers(): AgentFlowActivityApi {
    return {
      loadRunSnapshot: (input) => this.loadRunSnapshot(input),
      executeNode: (input) => this.executeNode(input),
      continueNode: (input) => this.continueNode(input),
      resumeNode: (input) => this.resumeNode(input),
      finalizeRun: (input) => this.finalizeRun(input),
    };
  }

  /**
   * 加载已由 StreamTask 锁定的 Flow 节点推进快照
   * @param input 当前 Workflow 的 task、version 与 digest 标识
   * @returns 返回只含节点键、节点类型、边与总时长的脱敏执行快照
   * @description 严格校验 StreamTask、FlowVersion 和 Workflow 输入三方一致；只将推进所需的结构交给 Temporal，不返回完整 Definition、会话内容、凭据、模型配置或工具原始数据。
   */
  async loadRunSnapshot(
    input: AgentFlowWorkflowInput,
  ): Promise<AgentFlowRunSnapshot> {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: input.streamTaskId },
      select: {
        id: true,
        flowVersionId: true,
        flowDigest: true,
        flowVersion: {
          select: {
            id: true,
            digest: true,
            definition: true,
          },
        },
      },
    });

    if (!task) {
      throw createNonRetryableActivityFailure(
        'Flow 任务不存在',
        'AGENT_FLOW_TASK_NOT_FOUND',
      );
    }
    if (
      task.flowVersionId !== input.flowVersionId ||
      task.flowVersion?.id !== input.flowVersionId
    ) {
      throw createNonRetryableActivityFailure(
        'FlowVersion 与任务快照不一致',
        'AGENT_FLOW_TASK_SNAPSHOT_MISMATCH',
      );
    }
    if (
      task.flowDigest !== input.flowDigest ||
      task.flowVersion.digest !== input.flowDigest
    ) {
      throw createNonRetryableActivityFailure(
        'Flow digest 与任务快照不一致',
        'AGENT_FLOW_TASK_SNAPSHOT_MISMATCH',
      );
    }

    const parsed = validateFlowDefinition(task.flowVersion.definition);
    if (!parsed.success) {
      throw createNonRetryableActivityFailure(
        'FlowVersion 中的 Definition 已损坏',
        'AGENT_FLOW_INVALID_SNAPSHOT',
      );
    }
    return toRunSnapshot(parsed.definition);
  }

  /**
   * 执行一个 Flow 节点
   * @param input 节点键与稳定 execution identity
   * @returns 返回完成分支、人工等待或明确停止结果
   * @description 从冻结 FlowVersion 重新编译当前节点，不进入 StrategyRouter。已完成和待审批节点回放已落库的事实；新执行先写 `flow.node.started`，再消费底层 agent 事件。
   */
  async executeNode(
    input: AgentFlowNodeExecutionInput,
  ): Promise<AgentFlowNodeExecutionResult> {
    return this.runNode(input, true);
  }

  /**
   * 继续推进已开始但未结束的节点
   * @param input 节点键与稳定 execution identity
   * @returns 返回完成分支、继续推进、人工等待或明确停止结果
   * @description 供 plan-loop 逐步执行：每次调用只推进一步，从节点私有状态里的
   * stepIndex 续跑。与 resumeNode 一样不重发 `flow.node.started`，否则同一节点会
   * 按步数刷出多条开始事件。
   */
  async continueNode(
    input: AgentFlowNodeExecutionInput,
  ): Promise<AgentFlowNodeExecutionResult> {
    return this.runNode(input, false);
  }

  /**
   * 执行或继续一个节点
   * @param input 节点键与稳定 execution identity
   * @param emitStarted 是否写入运行开始与节点开始事件
   * @returns 返回节点执行结果
   * @description 已完成、已停止与待审批节点一律回放已落库的事实，因此 Activity 重试与
   * Workflow 重复调度都不会重复执行副作用。
   */
  private async runNode(
    input: AgentFlowNodeExecutionInput,
    emitStarted: boolean,
  ): Promise<AgentFlowNodeExecutionResult> {
    const context = await this.loadExecutionContext(input);
    const terminalResult = toTerminalNodeResult(context.task.status);
    if (terminalResult) {
      return terminalResult;
    }
    const replayed = await this.replayFinishedNode(
      context,
      input.nodeExecutionId,
    );
    if (replayed) {
      return replayed;
    }

    if (emitStarted) {
      await this.emitRunAndNodeStarted(context, input.nodeExecutionId);
    }
    return this.executeCompiledNode(context, input, undefined);
  }

  /**
   * 取出当前节点在 Definition 里声明的合法分支键
   * @param context 当前编译后的节点执行上下文
   * @returns 返回该节点合法出边分支键的集合
   * @description 直接查 Definition 而不是编译后的 next 表：next 只记录实际连了出边的分支，
   * 用它当判据会把「声明了但没连线」的分支误判成非法。分支规则本身来自共享契约的
   * flowNodeBranchKeys，validator、快照与画布共用同一份。
   */
  private nodeBranchKeys(
    context: AgentFlowExecutionContext,
  ): readonly string[] {
    const node = context.definition.nodes.find(
      (item) => item.id === context.node.key,
    );
    if (!node) {
      throw createNonRetryableActivityFailure(
        'Flow 节点不存在',
        'AGENT_FLOW_INVALID_SNAPSHOT',
      );
    }
    return flowNodeBranchKeys(node);
  }

  /**
   * 回放一个已经存在终局事实的节点
   * @param context 当前编译后的节点执行上下文
   * @param nodeExecutionId 稳定节点执行标识
   * @returns 命中已落库结果或待审批事实时返回可直接交给 Workflow 的结果，否则返回 null
   * @description 幂等只依据两个数据库事实：`AgentFlowNodeExecution` 的唯一键
   * `(taskId, nodeExecutionId)`，以及本节点是否还有 PENDING 审批。原先靠
   * `executionState` 里的 JSON map（现已删除），整块读改写下并发节点会互相覆盖，丢一条完成记录就等于
   * 让重试重新调用模型与工具。审批不再另存一份 pendingApproval 快照：`AgentFlowApproval`
   * 本身就是唯一事实源，快照只能容纳一个等待中的节点，并行下必然失真。
   */
  private async replayFinishedNode(
    context: AgentFlowExecutionContext,
    nodeExecutionId: string,
  ): Promise<AgentFlowNodeExecutionResult | null> {
    const execution = await this.prisma.agentFlowNodeExecution.findUnique({
      where: {
        taskId_nodeExecutionId: { taskId: context.task.id, nodeExecutionId },
      },
      select: {
        result: true,
        outcome: true,
        summary: true,
        errorCategory: true,
      },
    });
    if (execution) {
      return toReplayedNodeResult(execution, this.nodeBranchKeys(context));
    }
    const pending = await this.prisma.agentFlowApproval.findFirst({
      where: {
        taskId: context.task.id,
        nodeKey: context.node.key,
        status: AgentFlowApprovalStatus.PENDING,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    return pending
      ? {
          kind: 'waiting_human',
          approvalId: pending.id,
          timeoutSeconds: FLOW_APPROVAL_TIMEOUT_SECONDS,
        }
      : null;
  }

  /**
   * 从已持久化审批决定恢复一个 Flow 节点
   * @param input 节点键、稳定 execution identity 与 approvalId
   * @returns 返回恢复后节点的完成分支、再次等待或明确停止结果
   * @description Signal 不携带决定正文；本方法在数据库读取已锁定的 `AgentFlowApproval`，只允许同一节点的 RESOLVED 记录恢复底层 LangGraph checkpoint。
   */
  async resumeNode(
    input: AgentFlowNodeResumeInput,
  ): Promise<AgentFlowNodeExecutionResult> {
    const context = await this.loadExecutionContext(input);
    const terminalResult = toTerminalNodeResult(context.task.status);
    if (terminalResult) {
      return terminalResult;
    }
    // 恢复路径同样要先回放：审批后的这次执行提交了事务、但结果上报丢失时，Temporal 会重试
    // resumeNode。此前这里没有幂等短路，重试会带着同一份决定把节点整个重跑一遍——模型重复
    // 调用，已审批通过的工具重复执行。
    const replayed = await this.replayFinishedNode(
      context,
      input.nodeExecutionId,
    );
    if (replayed) {
      return replayed;
    }
    const approval = await this.prisma.agentFlowApproval.findUnique({
      where: { id: input.approvalId },
      select: {
        taskId: true,
        nodeKey: true,
        kind: true,
        status: true,
        decision: true,
      },
    });
    if (
      !approval ||
      approval.taskId !== context.task.id ||
      approval.nodeKey !== input.nodeKey ||
      approval.status !== AgentFlowApprovalStatus.RESOLVED
    ) {
      throw createNonRetryableActivityFailure(
        'Flow 审批决定不存在或尚未完成',
        'AGENT_FLOW_APPROVAL_NOT_RESOLVED',
      );
    }
    const decision =
      approval.kind === AgentFlowApprovalKind.PLAN_REVIEW
        ? toPlanReviewDecision(approval.decision)
        : toApprovalDecision(approval.decision);
    if (!decision) {
      throw createNonRetryableActivityFailure(
        'Flow 审批决定格式无效',
        'AGENT_FLOW_APPROVAL_INVALID',
      );
    }
    const expectsPlanReview = context.node.type === 'approval';
    if (
      expectsPlanReview !==
      (approval.kind === AgentFlowApprovalKind.PLAN_REVIEW)
    ) {
      throw createNonRetryableActivityFailure(
        'Flow 审批类型与节点类型不匹配',
        'AGENT_FLOW_APPROVAL_KIND_MISMATCH',
      );
    }
    return this.executeCompiledNode(context, input, decision);
  }

  /**
   * 收敛一次 Flow Workflow 的终态
   * @param input 待持久化的受限终态、最后节点与安全错误类别
   * @returns 无返回值
   * @description 在事务内写入标准终态事件、任务/消息/run 状态与终态 trace，随后再收紧 Redis 帧保留窗口；重复调用已处于终态的任务不会产生第二组完成事件。
   */
  async finalizeRun(input: AgentFlowFinalizeRunInput): Promise<void> {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: input.workflow.streamTaskId },
      select: {
        id: true,
        userId: true,
        status: true,
        conversationId: true,
        messageId: true,
        currentRunId: true,
        fullContent: true,
      },
    });
    if (!task) {
      return;
    }
    const conversationId = task.conversationId;
    const messageId = task.messageId;
    if (!conversationId || !messageId) {
      return;
    }
    if (isTerminalTaskStatus(task.status)) {
      if (task.status === StreamTaskStatus.CANCELED) {
        await this.prisma.$transaction((transaction) =>
          this.settlePendingApprovalsInTransaction(
            transaction,
            task.id,
            AgentFlowApprovalStatus.CANCELED,
            '任务已取消',
          ),
        );
      }
      return;
    }

    const completed = input.status === 'completed';
    const cancelled = input.status === 'cancelled';
    const taskStatus = completed
      ? StreamTaskStatus.COMPLETED
      : cancelled
        ? StreamTaskStatus.CANCELED
        : StreamTaskStatus.ERROR;
    // 有具体原因就用它：泛化成「流程执行失败」会让用户和排障者都只能去翻 worker 日志。
    // errorReason 只可能来自我们自己抛的 ApplicationFailure，第三方错误已在 Workflow 侧滤掉。
    const errorMessage = completed
      ? undefined
      : cancelled
        ? '流程已取消'
        : input.errorReason?.trim() || '流程执行失败';
    const events = await this.prisma.$transaction(async (transaction) => {
      const persisted: PersistedAgentFlowTaskEvent[] = [];
      if (completed) {
        persisted.push(
          await this.taskEventService.persistInTransaction(transaction, {
            taskId: task.id,
            streamId: task.currentRunId,
            userId: task.userId,
            conversationId,
            messageId,
            eventName: StreamTaskEventType.MessageDone,
            status: StreamTaskStatus.STREAMING,
            payload: { content: task.fullContent },
            taskUpdate: { fullContent: task.fullContent },
          }),
        );
      }
      const eventName = completed
        ? StreamTaskEventType.TaskCompleted
        : cancelled
          ? StreamTaskEventType.TaskCanceled
          : StreamTaskEventType.TaskError;
      persisted.push(
        await this.taskEventService.persistInTransaction(transaction, {
          taskId: task.id,
          streamId: task.currentRunId,
          userId: task.userId,
          conversationId,
          messageId,
          eventName,
          status: taskStatus,
          ...(eventName === StreamTaskEventType.TaskError
            ? {
                errorMessage,
                payload: {
                  // 曾硬编码为 'server'，把配置错误（invalid）也说成"服务暂时不可用，
                  // 请稍后重试"，前端据此给出的重试建议是错的；类别由 Workflow 侧按
                  // ApplicationFailure 类型判定后传入
                  category: input.errorCategory ?? 'server',
                  retryable: isRetryableTaskErrorCategory(
                    input.errorCategory ?? 'server',
                  ),
                },
              }
            : {}),
          taskUpdate: {
            currentStep: input.lastNodeKey ?? taskStatus.toLowerCase(),
            completedAt: new Date(),
            fullContent: task.fullContent,
            errorMessage: errorMessage ?? null,
          },
        }),
      );
      await transaction.message.update({
        where: { id: messageId },
        data: {
          content: task.fullContent || errorMessage || '流程已完成',
          status: completed ? MessageStatus.DONE : MessageStatus.ERROR,
        },
      });
      if (task.currentRunId) {
        await transaction.streamTaskRun.update({
          where: { id: task.currentRunId },
          data: {
            status: completed
              ? StreamTaskRunStatus.COMPLETED
              : cancelled
                ? StreamTaskRunStatus.CANCELED
                : StreamTaskRunStatus.ERROR,
            endedAt: new Date(),
            closeReason: input.status,
            endEventId: persisted[persisted.length - 1]?.eventId,
          },
        });
      }
      if (!completed) {
        await this.settlePendingApprovalsInTransaction(
          transaction,
          task.id,
          cancelled
            ? AgentFlowApprovalStatus.CANCELED
            : input.status === 'timed_out'
              ? AgentFlowApprovalStatus.TIMED_OUT
              : AgentFlowApprovalStatus.ERROR,
          cancelled
            ? '任务已取消'
            : input.status === 'timed_out'
              ? '审批等待超时'
              : '流程执行失败',
        );
      }
      return persisted;
    });
    for (const event of events) {
      await this.taskEventService.publishAfterCommit(event);
    }
    await this.taskEventService.markCompletedAfterCommit(task.id);
  }

  /**
   * 加载并编译一个冻结的节点执行上下文
   * @param input Temporal 节点执行标识
   * @returns 返回已校验任务、FlowDefinition、编译节点与任务级模型/凭据快照
   * @description 编译使用任务锁定的 Agent 默认模型和用户凭据；不读取 Agent 当前绑定的草稿或调用旧策略路由，从而保证已经启动的 Flow 不受后续控制面修改影响。
   */
  private async loadExecutionContext(
    input: AgentFlowNodeExecutionInput,
  ): Promise<AgentFlowExecutionContext> {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: input.workflow.streamTaskId },
      select: {
        id: true,
        userId: true,
        status: true,
        conversationId: true,
        messageId: true,
        currentRunId: true,
        agentId: true,
        fullContent: true,
        flowModelCalls: true,
        flowToolCalls: true,
        requestPayload: true,
        resolvedAgentModelPresetId: true,
        resolvedAgentReasoningConfig: true,
        flowVersionId: true,
        flowDigest: true,
        flowVersion: {
          select: { id: true, flowId: true, digest: true, definition: true },
        },
      },
    });
    if (
      !task ||
      !task.conversationId ||
      !task.messageId ||
      !task.agentId ||
      task.flowVersionId !== input.workflow.flowVersionId ||
      task.flowDigest !== input.workflow.flowDigest ||
      task.flowVersion?.digest !== input.workflow.flowDigest
    ) {
      throw createNonRetryableActivityFailure(
        'Flow 节点任务上下文不完整或快照不一致',
        'AGENT_FLOW_TASK_SNAPSHOT_MISMATCH',
      );
    }
    const parsed = validateFlowDefinition(task.flowVersion.definition);
    if (!parsed.success) {
      throw createNonRetryableActivityFailure(
        'FlowVersion 中的 Definition 已损坏',
        'AGENT_FLOW_INVALID_SNAPSHOT',
      );
    }
    // Admin 与 Activity Worker 是独立进程；只刷新 API 进程内缓存会让 Flow 长期看不到
    // 新连接或新能力档位。Activity 边界刷新后，本次编译与模型解析读取同一份注册表。
    await this.modelRegistry.invalidate();
    const agent = await this.prisma.agent.findUnique({
      where: { id: task.agentId },
      select: { systemPrompt: true },
    });
    // 只在图上真有节点写 agent-default 时才要求：此前这里无条件拒绝，于是即使每个节点
    // 都指定了具体预设，也必须先给智能体配一个用不到的默认模型。按节点判定的精确报错由
    // 任务期校验（agent-default-resolved）给出，这里只是防御性兜底。
    if (
      !task.resolvedAgentModelPresetId &&
      flowDefinitionUsesAgentDefault(parsed.definition)
    ) {
      throw createNonRetryableActivityFailure(
        'Flow 任务未锁定智能体默认模型',
        'AGENT_FLOW_RUNTIME_CONTEXT_INVALID',
      );
    }
    const mcdonaldsCredentialId = readJsonString(
      task.requestPayload,
      'mcdonaldsCredentialId',
    );
    let agentDefaultReasoning:
      import('@litter-bear/types').ReasoningSelection | undefined;
    try {
      agentDefaultReasoning = parsePersistedReasoningConfig(
        task.resolvedAgentReasoningConfig,
      )?.selection;
    } catch {
      throw createNonRetryableActivityFailure(
        'Flow 任务锁定的思考配置已损坏',
        'AGENT_FLOW_TASK_SNAPSHOT_MISMATCH',
      );
    }
    const compiled = this.flowCompiler.compile(parsed.definition, {
      agentDefaultModelPreset: task.resolvedAgentModelPresetId,
      agentDefaultReasoning,
      ...(mcdonaldsCredentialId ? { mcdonaldsCredentialId } : {}),
    });
    if (!compiled.success) {
      const details = compiled.errors
        .slice(0, 5)
        .map((error) => `${error.path} [${error.rule}] ${error.message}`)
        .join('；');
      throw createNonRetryableActivityFailure(
        `Flow 任务期能力校验失败：${details}`,
        'AGENT_FLOW_RUNTIME_CONTEXT_INVALID',
      );
    }
    const node = compiled.plan.nodes.find((item) => item.key === input.nodeKey);
    if (!node) {
      throw createNonRetryableActivityFailure(
        'Flow 节点不存在',
        'AGENT_FLOW_INVALID_SNAPSHOT',
      );
    }
    return {
      task: {
        id: task.id,
        userId: task.userId,
        status: task.status,
        conversationId: task.conversationId,
        messageId: task.messageId,
        streamId: task.currentRunId,
        agentId: task.agentId,
        fullContent: task.fullContent,
        budgetUsage: {
          modelCalls: task.flowModelCalls,
          toolCalls: task.flowToolCalls,
        },
        inputText: readJsonString(task.requestPayload, 'content') ?? '',
        ...(readJsonString(task.requestPayload, 'imageAssetId')
          ? {
              imageAssetId: readJsonString(task.requestPayload, 'imageAssetId'),
            }
          : {}),
        flowVersionId: task.flowVersionId,
        flowDigest: task.flowDigest,
      },
      flowId: task.flowVersion.flowId,
      definition: parsed.definition,
      compiledPlan: compiled.plan,
      node,
      agentSystemPrompt: agent?.systemPrompt ?? null,
      ...(mcdonaldsCredentialId ? { mcdonaldsCredentialId } : {}),
    };
  }

  /**
   * 写入 Flow 运行开始和节点开始事件
   * @param context 当前编译后的节点执行上下文
   * @param nodeExecutionId 稳定节点执行标识
   * @returns 无返回值
   * @description 首次节点前写 `flow.run.started`，每个节点写 `flow.node.started`。两个事件在同一事务内递增语义 eventId，事务提交后依序追加 Redis 帧。
   * 「是否首次」由 `flowRunStartedAt IS NULL` 的条件更新原子声明：只有更新到 1 行的那个节点发 run.started。
   * 原先读 executionState 里的 started 布尔再整块写回，是先读后写的竞态；并行扇出时多个首节点会各发一次 run.started。
   */
  private async emitRunAndNodeStarted(
    context: AgentFlowExecutionContext,
    nodeExecutionId: string,
  ): Promise<void> {
    const events = await this.prisma.$transaction(async (transaction) => {
      const persisted: PersistedAgentFlowTaskEvent[] = [];
      const claimed = await transaction.streamTask.updateMany({
        where: { id: context.task.id, flowRunStartedAt: null },
        data: { flowRunStartedAt: new Date() },
      });
      if (claimed.count === 1) {
        persisted.push(
          await this.taskEventService.persistInTransaction(transaction, {
            taskId: context.task.id,
            streamId: context.task.streamId,
            userId: context.task.userId,
            conversationId: context.task.conversationId,
            messageId: context.task.messageId,
            eventName: StreamTaskEventType.FlowRunStarted,
            status: StreamTaskStatus.STREAMING,
            payload: {
              flowId: context.flowId,
              flowVersionId: context.task.flowVersionId,
              digest: context.task.flowDigest,
            },
            taskUpdate: {
              startedAt: new Date(),
              currentStep: context.node.key,
            },
          }),
        );
      }
      persisted.push(
        await this.taskEventService.persistInTransaction(transaction, {
          taskId: context.task.id,
          streamId: context.task.streamId,
          userId: context.task.userId,
          conversationId: context.task.conversationId,
          messageId: context.task.messageId,
          eventName: StreamTaskEventType.FlowNodeStarted,
          status: StreamTaskStatus.STREAMING,
          payload: {
            nodeKey: context.node.key,
            nodeType: context.node.type,
            title: getNodeTitle(context.node),
            traceKey: createNodeTraceKey(nodeExecutionId),
          },
          taskUpdate: {
            currentStep: context.node.key,
          },
        }),
      );
      return persisted;
    });
    for (const event of events) {
      await this.taskEventService.publishAfterCommit(event);
    }
  }

  /**
   * 分派一个已编译节点的实际执行
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param resumeDecision 已持久化的工具审批决定；首轮执行时缺省
   * @returns 返回完成分支、等待人工或明确停止结果
   * @description V1 启用 agent、synthesize、plan、plan-loop 与 approval；未知节点类型明确失败，不复用整张旧策略图造成重复规划或越权执行。
   */
  private async executeCompiledNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    resumeDecision: ApprovalDecision | PlanReviewDecision | undefined,
  ): Promise<AgentFlowNodeExecutionResult> {
    if (context.node.type === 'agent') {
      return this.executeAgentNode(
        context,
        input,
        context.node,
        resumeDecision as ApprovalDecision | undefined,
      );
    }
    if (context.node.type === 'synthesize') {
      return this.executeSynthesizeNode(
        context,
        input,
        context.node,
        resumeDecision,
      );
    }
    if (context.node.type === 'plan') {
      return this.executePlanNode(context, input, context.node);
    }
    if (context.node.type === 'approval') {
      return this.executePlanReviewNode(
        context,
        input,
        context.node,
        resumeDecision as PlanReviewDecision | undefined,
      );
    }
    if (context.node.type === 'start') {
      // 起始节点不调模型、不产生副作用，只把用户本轮消息作为声明输出交给下游引用。
      // 仍然走 completeNode：节点执行事实与输出必须和其他节点一样落库，否则下游
      // 经 $ref 读它时会撞上「上游节点没有已落库的输出」。
      return this.completeNode(context, input, 'default', '流程开始', {
        outputs: { text: context.task.inputText },
      });
    }
    if (context.node.type === 'end') {
      // end 不调模型、不调用工具，也不产生输出；仍落节点终局事实，让 trace 与幂等回放都能
      // 明确看到流程确实经过了声明的结束节点。
      return this.completeNode(context, input, 'default', '流程结束');
    }
    if (context.node.type === 'join') {
      // 汇聚本身不做任何事：等谁、等多少个由 Workflow 按快照判定，Activity 只留下一条
      // 「已汇聚」的终局事实，让 trace 上能看到分支在这里合流。
      return this.completeNode(context, input, 'default', '并行分支已汇聚');
    }
    if (context.node.type === 'condition') {
      return this.executeConditionNode(context, input, context.node);
    }
    if (context.node.type === 'loop') {
      return this.executeLoopNode(context, input, context.node);
    }
    if (context.node.type === 'plan-loop') {
      return this.executePlanLoopNode(
        context,
        input,
        context.node,
        resumeDecision as ApprovalDecision | undefined,
      );
    }
    throw createNonRetryableActivityFailure(
      'Flow 节点执行器状态非法',
      'AGENT_FLOW_NODE_EXECUTOR_UNAVAILABLE',
    );
  }

  /**
   * 执行一个 Flow 计划节点
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param node 已编译的计划节点，包含步骤预算与具体模型预设
   * @returns 返回已持久化计划后的默认完成分支；预算已耗尽时返回停止结果
   * @description 规划使用既有 PlannerService 的结构化输出与单步降级语义；计划正文只写入任务执行状态，绝不进入客户端消息增量或 Temporal History。
   */
  private async executePlanNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    node: Extract<CompiledFlowNode, { type: 'plan' }>,
  ): Promise<AgentFlowNodeExecutionResult> {
    const budget = this.createBudgetTracker(context);
    if (budget.modelCallExhausted()) {
      return this.stopOnBudgetExceeded(context, input, 'maxModelCalls');
    }
    const plan = await this.createPlan(
      context,
      node.maxSteps,
      [],
      node.modelPreset,
      node.reasoning,
    );
    // 只在真的调了模型时记账：fromModel 为 false 说明 Planner 已降级为规则单步计划。
    // fromModel 只在这里用于记账，不再持久化——它唯一的下游消费者 buildStepPrompt 从不读它。
    if (plan.fromModel) {
      budget.countModelCall();
    }
    await budget.flush();
    return this.completeNode(
      context,
      input,
      'default',
      `已生成 ${plan.steps.length} 个计划步骤`,
      { outputs: { steps: plan.steps, stepCount: plan.steps.length } },
    );
  }

  /**
   * 执行或恢复一个计划审批节点
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param decision 已持久化的计划审批决定；首轮为空
   * @returns 返回审批等待、已确认分支或用户终止结果
   * @description `reject_replan` 在审批节点内部重新生成计划并创建下一轮审批，不通过图上的回边重新执行 plan 节点，因此不会重复节点生命周期事件或破坏冻结图的无环约束。
   */
  private async executePlanReviewNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    node: Extract<CompiledFlowNode, { type: 'approval' }>,
    decision: PlanReviewDecision | undefined,
  ): Promise<AgentFlowNodeExecutionResult> {
    const scratch = await this.readApprovalScratch(context, input);
    const steps =
      scratch.steps ?? (await this.readPlanSteps(context, node.planRef));

    if (!decision) {
      return this.openPlanReview(context, input, node, steps, scratch);
    }

    if (decision.decision === 'approve') {
      return this.completeApproval(context, input, steps, '计划已确认');
    }
    if (decision.decision === 'edit') {
      const edited = toEditedPlanSteps(decision.editedSteps);
      return this.completeApproval(
        context,
        input,
        edited,
        `已确认修改后的 ${edited.length} 个计划步骤`,
      );
    }
    if (decision.decision === 'reject_terminate') {
      return this.stopNode(
        context,
        input,
        'completed',
        '用户已终止计划',
        '好的，已按你的选择终止本次任务。',
      );
    }

    const feedback = decision.feedback?.trim() || '请重新规划';
    const nextFeedback = [...scratch.feedback, feedback];
    const budget = this.createBudgetTracker(context);
    if (budget.modelCallExhausted()) {
      return this.stopOnBudgetExceeded(context, input, 'maxModelCalls');
    }
    const planNode = this.readPlanNode(context, node.planRef);
    const replanned = await this.createPlan(
      context,
      planNode.maxSteps,
      nextFeedback,
      planNode.modelPreset,
      planNode.reasoning,
    );
    // 重新规划同样是一次真实模型调用，反复 reject_replan 必须计入预算
    if (replanned.fromModel) {
      budget.countModelCall();
    }
    await budget.flush();
    const nextScratch: ApprovalScratch = {
      revision: scratch.revision + 1,
      feedback: nextFeedback,
      steps: replanned.steps,
    };
    await this.writeNodeState(context, input, nextScratch);
    return this.createPlanReviewApprovalWait(
      context,
      input,
      replanned.steps,
      nextScratch.revision,
    );
  }

  /**
   * 按门禁策略决定这轮审批是等人、还是自动通过
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param node 已编译的审批节点
   * @param steps 待审的计划步骤
   * @param scratch 本节点已持久化的审批轮次状态
   * @returns 返回等待人工或直接确认的结果
   * @description `model` 策略**失败闭合**：模型不可用、输出非法或模型额度已耗尽时一律按
   * 「需要人工确认」处理。这道门禁只决定「要不要请人过目计划」，不是安全边界——工具审批由
   * CapabilityRegistry 单独推导，Flow 配置没有降低工具风险等级的入口。
   */
  private async openPlanReview(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    node: Extract<CompiledFlowNode, { type: 'approval' }>,
    steps: PlanStep[],
    scratch: ApprovalScratch,
  ): Promise<AgentFlowNodeExecutionResult> {
    if (node.policy === 'never') {
      return this.completeApproval(context, input, steps, '按配置自动确认计划');
    }
    if (node.policy === 'model') {
      const verdict = await this.judgePlanReviewNeeded(
        context,
        steps,
        node.modelPreset,
        node.reasoning,
      );
      if (!verdict.needsReview) {
        return this.completeApproval(
          context,
          input,
          steps,
          `模型判定无需人工确认：${verdict.reason}`,
        );
      }
    }
    await this.writeNodeState(context, input, { ...scratch, steps });
    return this.createPlanReviewApprovalWait(
      context,
      input,
      steps,
      scratch.revision,
    );
  }

  /**
   * 由模型判断一份计划是否需要人工确认
   * @param context 当前编译后的节点执行上下文
   * @param steps 待审的计划步骤
   * @param modelPreset 审批节点编译后锁定的模型预设业务标识
   * @returns 返回判定结果与一句理由
   * @description 任何失败路径都返回「需要人工确认」：模型额度耗尽、调用异常、输出不符合闭集
   * 都算失败。漏掉一次该确认的代价远大于多问一次，因此这里不能失败开放。
   */
  private async judgePlanReviewNeeded(
    context: AgentFlowExecutionContext,
    steps: PlanStep[],
    modelPreset: string | undefined,
    reasoning: import('@litter-bear/types').ReasoningSelection | undefined,
  ): Promise<{ needsReview: boolean; reason: string }> {
    const budget = this.createBudgetTracker(context);
    if (!modelPreset) {
      return { needsReview: true, reason: '门禁模型配置缺失，转人工确认' };
    }
    if (budget.modelCallExhausted()) {
      return { needsReview: true, reason: '模型调用额度已用尽，转人工确认' };
    }
    try {
      const parsed = await this.llmService.generateStructured(
        [
          { role: 'system', content: planReviewGatePrompt },
          {
            role: 'user',
            content: steps
              .map((step, index) => `${index + 1}. ${step.goal}`)
              .join('\n'),
          },
        ],
        planReviewGateSchema,
        {
          schemaName: 'plan_review_gate',
          request: {
            model: { modelId: modelPreset },
            reasoning,
          },
        },
      );
      budget.countModelCall();
      await budget.flush();
      if (!parsed) {
        return {
          needsReview: true,
          reason: '门禁判定未产出有效结果，转人工确认',
        };
      }
      return {
        needsReview: parsed.needsReview,
        reason: parsed.reason.trim() || '模型未给出理由',
      };
    } catch {
      // 计入已发出的调用后再返回：调用可能已经打到上游，不记账等于漏掉真实花费
      await budget.flush();
      return { needsReview: true, reason: '门禁判定失败，转人工确认' };
    }
  }

  /**
   * 以确认结果完成审批节点
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param steps 最终确认的计划步骤
   * @param summary 可展示的完成摘要
   * @returns 返回 approved 分支的完成结果
   * @description 输出里带上 steps：下游要执行「人确认过的那份」计划就引用本节点，
   * 要执行原始计划才引用上游 plan 节点。编辑过的计划只在这里可见。
   */
  private async completeApproval(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    steps: PlanStep[],
    summary: string,
  ): Promise<AgentFlowNodeExecutionResult> {
    return this.completeNode(context, input, 'approved', summary, {
      outputs: {
        approved: true,
        comment: '',
        steps,
        stepCount: steps.length,
      },
    });
  }

  /**
   * 执行一个 Flow PlanLoop 节点
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param node 已完成能力闭集编译的 PlanLoop 节点
   * @param resumeDecision 可选的已持久化工具审批决定
   * @returns 返回步骤全部完成、再次等待工具审批或明确停止结果
   * @description 每个步骤在 PostgreSQL 中同步 checkpoint；恢复时从 stepIndex、观察摘要和稳定 step threadId 继续，只复用底层 ReAct 子图，不调用完整的遗留 PlanGraphRunner。
   */
  private async executePlanLoopNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    node: Extract<CompiledFlowNode, { type: 'plan-loop' }>,
    resumeDecision: ApprovalDecision | undefined,
  ): Promise<AgentFlowNodeExecutionResult> {
    const steps = await this.readPlanSteps(context, node.planRef);
    let planLoop = await this.readPlanLoopScratch(context, input);
    const budget = this.createBudgetTracker(context);
    const capabilities = await this.capabilityResolver.resolve(
      toFlowCapabilityDecision(node.executor),
      context.task.userId,
      context.mcdonaldsCredentialId,
    );
    const chatContext = await this.chatContextService.buildContextBundle(
      context.task.conversationId,
      context.task.messageId,
      context.task.agentId,
    );
    const systemPrompt = mergeSystemPrompt(
      context.agentSystemPrompt,
      capabilities.systemPromptAdditions,
    );
    const agentInput: AgentLoopInput = {
      userId: context.task.userId,
      messages: chatContext.messages,
      systemPrompt,
      tools: capabilities.tools,
      approvalToolNames: capabilities.approvalToolNames,
    };

    const stepLimit = Math.min(steps.length, node.planLoopPolicy.maxSteps);
    // 单步执行：循环由 Workflow 驱动。整条循环压在一次 Activity 里时，实测 5 步
    // 已耗 197s / 300s 预算（约 40s/步），schema 允许的 24 步必然超时；且循环期间
    // Workflow 既检查不到 maxDurationSeconds 也收不到取消信号。
    if (planLoop.stepIndex >= stepLimit) {
      return this.completeNode(
        context,
        input,
        'default',
        `已完成 ${planLoop.stepIndex} 个计划步骤`,
        { outputs: toPlanLoopOutputs(planLoop) },
      );
    }

    if (budget.modelCallExhausted()) {
      return this.stopOnBudgetExceeded(context, input, 'maxModelCalls');
    }

    const step = steps[planLoop.stepIndex];
    const stepExecutionId = createPlanStepExecutionId(
      input.nodeExecutionId,
      step.id,
    );
    const tools = filterToolsForPlanStep(
      capabilities.tools,
      step.suggestedTools,
    );
    const approvalToolNames = filterApprovalToolsForPlanStep(
      capabilities.approvalToolNames,
      step.suggestedTools,
    );
    const stepPrompt = buildStepPrompt(
      agentInput,
      steps,
      step,
      planLoop.observations,
    );
    const stream = resumeDecision
      ? this.commonChatAgentService.resumeEvents({
          modelPreset: node.executor.modelPreset,
          reasoning: node.executor.reasoning,
          messages: chatContext.messages,
          systemPrompt: stepPrompt,
          tools,
          threadId: stepExecutionId,
          approvalToolNames,
          decision: resumeDecision,
          onModelTurn: budget.countModelCall,
          modelRuntime: AGENT_FLOW_MODEL_RUNTIME,
        })
      : this.commonChatAgentService.streamEvents({
          modelPreset: node.executor.modelPreset,
          reasoning: node.executor.reasoning,
          messages: chatContext.messages,
          systemPrompt: stepPrompt,
          tools,
          threadId: stepExecutionId,
          approvalToolNames,
          onModelTurn: budget.countModelCall,
          modelRuntime: AGENT_FLOW_MODEL_RUNTIME,
        });
    let result: Awaited<ReturnType<AgentFlowActivities['consumeAgentStream']>>;
    try {
      result = await this.consumeAgentStream(context, input, stream, {
        initialContent: '',
        publishMessageDelta: false,
        budget,
      });
    } catch (error) {
      throw toAgentFlowModelFailure(error);
    }
    resumeDecision = undefined;
    await budget.flush();
    if (result.overspent) {
      // 已完成的观察留在 scratch 里：预算终止不回滚已产出的步骤成果
      return this.stopOnBudgetExceeded(context, input, result.overspent);
    }
    if (result.approvals.length > 0) {
      return this.createToolApprovalWait(
        context,
        input,
        result.approvals,
        context.task.fullContent,
        createApprovalTraceKey(stepExecutionId),
      );
    }

    planLoop = {
      stepIndex: planLoop.stepIndex + 1,
      observations: [...planLoop.observations, result.fullContent],
      lastStepHadToolCalls: result.hadToolCalls,
    };
    await this.persistPlanLoopCheckpoint(context, input, planLoop);

    if (
      planLoop.stepIndex >= stepLimit ||
      (node.planLoopPolicy.stopPolicy === 'evaluate-after-step' &&
        this.stepEvaluator.enough({
          stepsDone: planLoop.stepIndex,
          maxSteps: node.planLoopPolicy.maxSteps,
          plannedSteps: steps.length,
          lastResult: {
            text: result.fullContent,
            hadToolCalls: result.hadToolCalls,
          },
        }))
    ) {
      return this.completeNode(
        context,
        input,
        'default',
        `已完成 ${planLoop.stepIndex} 个计划步骤`,
        { outputs: toPlanLoopOutputs(planLoop) },
      );
    }

    // checkpoint 已落库，下一步由 Workflow 再调度一次 continueNode 从 stepIndex 续跑
    return { kind: 'continued', completedSteps: planLoop.stepIndex };
  }

  /**
   * 判定一个条件分支节点
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param node 已编译的 condition 节点
   * @returns 返回命中分支键的完成结果
   * @description 不调用模型、不产生输出，只按声明顺序求值 case 并给出分支键；全不命中走隐含的
   * else 分支。取值来自上游节点已落库的声明输出与 `$input`，而不是任何模型输出。
   */
  private async executeConditionNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    node: CompiledConditionFlowNode,
  ): Promise<AgentFlowNodeExecutionResult> {
    const upstream = await this.loadUpstreamOutputs(context.task.id);
    const resolve = (ref: readonly [string, string]): unknown => {
      const [sourceId, field] = ref;
      const outputs = upstream.get(sourceId);
      if (!outputs) {
        // 发布期的 ref-dominates 已保证被引节点在每条路径上都必定先完成，因此这里读不到
        // 就是我们自己的写入漏了，而不是用户配错。静默判 false 会让分支永远走 else——
        // 那正是旧 condition stub「永远算不对」的失败方式，必须显式失败。
        throw createNonRetryableActivityFailure(
          `条件引用的上游节点「${sourceId}」没有已落库的输出`,
          'AGENT_FLOW_RUNTIME_CONTEXT_INVALID',
        );
      }
      return outputs[field];
    };

    const matched = node.cases.find((branch) =>
      evaluateConditionCase(branch, resolve),
    );
    const outcome = matched?.key ?? FLOW_CONDITION_ELSE_BRANCH;
    return this.completeNode(context, input, outcome, `命中分支「${outcome}」`);
  }

  /**
   * 执行一个循环边界节点
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 下传的稳定轮次与节点执行标识
   * @param node 已编译的循环配置
   * @returns 返回 again 或 done 分支，并把面向下一轮的轮次声明为节点输出
   * @description 第一次到达 loop 时 iteration 为 0，此时尚无循环体输出，必定进入第 1 轮。
   * 后续到达先执行 continueWhen；达到 maxIterations 时无条件退出。轮次由 Workflow 持有，
   * Activity 不查库推算，避免 Temporal 重试同一轮时改变幂等键并重复执行外部副作用。
   */
  private async executeLoopNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    node: CompiledLoopFlowNode,
  ): Promise<AgentFlowNodeExecutionResult> {
    const iteration = input.iteration;
    if (!Number.isInteger(iteration) || iteration < 0) {
      throw createNonRetryableActivityFailure(
        'Flow 循环轮次非法',
        'AGENT_FLOW_INVALID_SNAPSHOT',
      );
    }

    let shouldContinue = iteration === 0;
    if (
      iteration > 0 &&
      iteration < node.maxIterations &&
      node.continueWhen.length === 0
    ) {
      shouldContinue = true;
    } else if (
      iteration > 0 &&
      iteration < node.maxIterations &&
      node.continueWhen.length > 0
    ) {
      const upstream = await this.loadUpstreamOutputs(context.task.id);
      const resolve = (ref: readonly [string, string]): unknown => {
        const [sourceId, field] = ref;
        const outputs = upstream.get(sourceId);
        if (!outputs) {
          throw createNonRetryableActivityFailure(
            `循环引用的节点「${sourceId}」没有已落库的输出`,
            'AGENT_FLOW_RUNTIME_CONTEXT_INVALID',
          );
        }
        return outputs[field];
      };
      shouldContinue = node.continueWhen.some((branch) =>
        evaluateConditionCase(branch, resolve),
      );
    }

    const outcome = shouldContinue
      ? FLOW_LOOP_AGAIN_BRANCH
      : FLOW_LOOP_DONE_BRANCH;
    const visibleIteration = shouldContinue ? iteration + 1 : iteration;
    return this.completeNode(
      context,
      input,
      outcome,
      shouldContinue
        ? `进入第 ${visibleIteration} 轮循环`
        : `循环在第 ${visibleIteration} 轮后结束`,
      { outputs: { iteration: visibleIteration } },
    );
  }

  /**
   * 读取本任务已完成节点的声明输出
   * @param taskId 当前 Flow 任务标识
   * @returns 返回节点键到其输出对象的映射
   * @description 循环会让同一 nodeKey 产生多行；以 nodeExecutionId 末尾的数字轮次比较，
   * 只保留最近一轮。不能按 createdAt 排序：时间精度不足时同一毫秒仍无确定顺序。
   * nodeExecutionId 同时作为相同轮次下的稳定次序；没有轮次段的旧记录按第 0 轮读取。
   */
  private async loadUpstreamOutputs(
    taskId: string,
  ): Promise<Map<string, Prisma.JsonObject>> {
    const rows = await this.prisma.agentFlowNodeExecution.findMany({
      where: { taskId },
      select: { nodeKey: true, nodeExecutionId: true, outputs: true },
      orderBy: { nodeExecutionId: 'asc' },
    });
    const outputs = new Map<string, Prisma.JsonObject>();
    const latestIdentity = new Map<
      string,
      { iteration: number; nodeExecutionId: string }
    >();
    for (const row of rows) {
      if (!isJsonObject(row.outputs)) {
        continue;
      }
      const candidate = {
        iteration: readNodeExecutionIteration(row.nodeExecutionId),
        nodeExecutionId: row.nodeExecutionId,
      };
      const current = latestIdentity.get(row.nodeKey);
      if (
        current &&
        (current.iteration > candidate.iteration ||
          (current.iteration === candidate.iteration &&
            current.nodeExecutionId >= candidate.nodeExecutionId))
      ) {
        continue;
      }
      latestIdentity.set(row.nodeKey, candidate);
      outputs.set(row.nodeKey, row.outputs);
    }
    return outputs;
  }

  /**
   * 执行最终汇总节点
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param resumeDecision 可选的工具审批决定
   * @returns 返回汇总回复完成或工具审批等待结果
   * @description 汇总素材由 observationsRef 显式指定，不再隐式读全局的 PlanLoop 状态——图上有
   * 两个 plan-loop 时那种隐式读法根本说不清汇总的是谁。缺省引用时保持普通无工具 Agent 汇总语义。
   * 步骤观察只进提示词，不直接下发客户端。
   */
  private async executeSynthesizeNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    node: Extract<CompiledFlowNode, { type: 'synthesize' }>,
    resumeDecision: ApprovalDecision | PlanReviewDecision | undefined,
  ): Promise<AgentFlowNodeExecutionResult> {
    const observations = node.observationsRef
      ? await this.readRefStringArray(context, node.observationsRef)
      : [];
    const agentInput = await this.createAgentLoopInput(context, []);
    const systemPrompt = buildSynthesisPrompt(agentInput, observations);
    return this.executeAgentNode(
      context,
      input,
      toSynthesizeExecutor(node.modelPreset, node.reasoning),
      resumeDecision as ApprovalDecision | undefined,
      systemPrompt,
    );
  }

  /**
   * 使用既有 PlannerService 创建一份任务计划
   * @param context 当前 Flow 节点执行上下文
   * @param maxSteps 当前计划步骤预算
   * @param feedback 已累计的计划打回意见
   * @param modelPreset 当前 plan 节点编译后锁定的模型预设业务标识
   * @returns 返回结构化或降级后的计划
   * @description Planner 的模型调用失败会在其内部回退为单步计划；本方法只负责把冻结会话与系统提示词转换成其所需输入，确保 Flow 不进入旧策略路由。
   */
  private async createPlan(
    context: AgentFlowExecutionContext,
    maxSteps: number,
    feedback: string[],
    modelPreset: string,
    reasoning?: import('@litter-bear/types').ReasoningSelection,
  ): Promise<AgentPlan> {
    const input = await this.createAgentLoopInput(context, []);
    return this.planner.plan(input, maxSteps, feedback, modelPreset, reasoning);
  }

  /**
   * 创建 Flow 节点复用的 AgentLoop 输入
   * @param context 当前 Flow 节点执行上下文
   * @param tools 已经完成能力闭集校验的工具集
   * @returns 返回可供 Planner 或 prompt builder 使用的最小输入
   * @description 该输入不包含旧策略、HTTP 请求对象或 Temporal 数据；Flow 节点只用它传递冻结会话、合并后的系统提示词和受控工具名。
   */
  private async createAgentLoopInput(
    context: AgentFlowExecutionContext,
    tools: unknown[],
  ): Promise<AgentLoopInput> {
    const chatContext = await this.chatContextService.buildContextBundle(
      context.task.conversationId,
      context.task.messageId,
      context.task.agentId,
    );
    return {
      userId: context.task.userId,
      messages: chatContext.messages,
      systemPrompt: mergeSystemPrompt(context.agentSystemPrompt, []),
      tools,
    };
  }

  /**
   * 为计划审批创建或复用一条持久化等待事实
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param state 当前含计划快照的运行状态
   * @returns 返回 Workflow 可等待的稳定审批标识
   * @description 同一审批节点和修订轮次的 Activity retry 会复用 PENDING 记录；打回重规划后 revision 递增，才允许创建下一条审批 trace 与事件。
   */
  private async createPlanReviewApprovalWait(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    steps: PlanStep[],
    revision: number,
  ): Promise<AgentFlowNodeExecutionResult> {
    const existing = await this.prisma.agentFlowApproval.findFirst({
      where: {
        taskId: context.task.id,
        nodeKey: context.node.key,
        kind: AgentFlowApprovalKind.PLAN_REVIEW,
        status: AgentFlowApprovalStatus.PENDING,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return {
        kind: 'waiting_human',
        approvalId: existing.id,
        timeoutSeconds: FLOW_APPROVAL_TIMEOUT_SECONDS,
      };
    }
    const expiresAt = new Date(
      Date.now() + FLOW_APPROVAL_TIMEOUT_SECONDS * 1_000,
    );
    const traceKey = createPlanReviewTraceKey(input.nodeExecutionId, revision);
    const result = await this.prisma.$transaction(async (transaction) => {
      const approval = await transaction.agentFlowApproval.create({
        data: {
          taskId: context.task.id,
          runId: context.task.streamId,
          nodeKey: context.node.key,
          kind: AgentFlowApprovalKind.PLAN_REVIEW,
          requestSummary: toInputJsonValue({
            steps: steps.map((step) => ({ id: step.id, goal: step.goal })),
            revision,
            allowedDecisions: [
              'approve',
              'edit',
              'reject_replan',
              'reject_terminate',
            ],
          }),
        },
      });
      const event = await this.taskEventService.persistInTransaction(
        transaction,
        {
          taskId: context.task.id,
          streamId: context.task.streamId,
          userId: context.task.userId,
          conversationId: context.task.conversationId,
          messageId: context.task.messageId,
          eventName: StreamTaskEventType.FlowWaitingHuman,
          status: StreamTaskStatus.WAITING_HUMAN,
          payload: {
            approvalId: approval.id,
            nodeKey: context.node.key,
            traceKey,
            approval: {
              kind: 'plan-review',
              steps: steps.map((step) => ({
                id: step.id,
                goal: step.goal,
              })),
              revision,
              allowedDecisions: [
                'approve',
                'edit',
                'reject_replan',
                'reject_terminate',
              ],
            },
            expiresAt: expiresAt.toISOString(),
          },
          taskUpdate: {
            currentStep: context.node.key,
            pausedAt: new Date(),
            expiresAt,
          },
        },
      );
      if (event.traceItemId) {
        await transaction.agentFlowApproval.update({
          where: { id: approval.id },
          data: { traceItemId: event.traceItemId },
        });
      }
      return { approvalId: approval.id, event };
    });
    await this.taskEventService.publishAfterCommit(result.event);
    return {
      kind: 'waiting_human',
      approvalId: result.approvalId,
      timeoutSeconds: FLOW_APPROVAL_TIMEOUT_SECONDS,
    };
  }

  /**
   * 运行一个不经过旧策略路由的 Agent 节点
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param node 已完成能力闭集编译的 Agent 执行器
   * @param resumeDecision 可选的已持久化工具审批决定
   * @returns 返回完成分支或下一次人工等待
   * @description 能力装配严格由 FlowCompiler + CapabilityResolver 驱动，底层只调用 CommonChatAgentService；不调用 StrategyRouter、StrategyRegistry 或 CommonChatAgentRunner 的路由入口。
   */
  private async executeAgentNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    node: Omit<CompiledAgentFlowNode, 'key' | 'type'>,
    resumeDecision: ApprovalDecision | undefined,
    systemPromptOverride?: string,
  ): Promise<AgentFlowNodeExecutionResult> {
    const capabilities = await this.capabilityResolver.resolve(
      toFlowCapabilityDecision(node),
      context.task.userId,
      context.mcdonaldsCredentialId,
    );
    const chatContext = await this.chatContextService.buildContextBundle(
      context.task.conversationId,
      context.task.messageId,
      context.task.agentId,
    );
    const systemPrompt =
      systemPromptOverride ??
      mergeSystemPrompt(
        context.agentSystemPrompt,
        capabilities.systemPromptAdditions,
      );
    const budget = this.createBudgetTracker(context);
    if (budget.modelCallExhausted()) {
      return this.stopOnBudgetExceeded(context, input, 'maxModelCalls');
    }
    const onModelTurn = budget.countModelCall;
    // 只有终节点保存供应商私有上下文；中间节点不得把它带入 outputs 或消息表。
    const isAnswer = isAnswerNode(context);
    const vision =
      isAnswer && context.task.imageAssetId
        ? await this.prepareAnswerVision(
            context,
            node.modelPreset,
            chatContext.messages,
          )
        : undefined;
    let modelContext: ModelContextEnvelope | undefined;
    const onCompletedModelContext = isAnswer
      ? (contextValue: ModelContextEnvelope) => {
          modelContext = contextValue;
        }
      : undefined;
    const stream = resumeDecision
      ? this.commonChatAgentService.resumeEvents({
          modelPreset: node.modelPreset,
          reasoning: node.reasoning,
          messages: vision?.messages ?? chatContext.messages,
          systemPrompt,
          tools: capabilities.tools,
          threadId: input.nodeExecutionId,
          approvalToolNames: capabilities.approvalToolNames,
          decision: resumeDecision,
          onModelTurn,
          modelRuntime: AGENT_FLOW_MODEL_RUNTIME,
          ...(onCompletedModelContext ? { onCompletedModelContext } : {}),
          ...(vision?.transform ? { visionTransform: vision.transform } : {}),
        })
      : this.commonChatAgentService.streamEvents({
          modelPreset: node.modelPreset,
          reasoning: node.reasoning,
          messages: vision?.messages ?? chatContext.messages,
          systemPrompt,
          tools: capabilities.tools,
          threadId: input.nodeExecutionId,
          approvalToolNames: capabilities.approvalToolNames,
          onModelTurn,
          modelRuntime: AGENT_FLOW_MODEL_RUNTIME,
          ...(onCompletedModelContext ? { onCompletedModelContext } : {}),
          ...(vision?.transform ? { visionTransform: vision.transform } : {}),
        });
    // 只有终节点的产出会成为这条助手消息的正文；中间 agent 节点静默执行，正文进
    // outputs.text 供下游 $ref 引用。理由见 isAnswerNode。
    let result: Awaited<ReturnType<AgentFlowActivities['consumeAgentStream']>>;
    try {
      result = await this.consumeAgentStream(context, input, stream, {
        initialContent: isAnswer ? context.task.fullContent : '',
        publishMessageDelta: isAnswer,
        budget,
      });
    } catch (error) {
      throw toAgentFlowModelFailure(error);
    }
    await budget.flush();
    // 中间节点的正文不能进任务：它是从空串起算的自己那一段，写进 fullContent 会
    // 覆盖掉真正的回复。中止与等待两条路径都要按这个走。
    const answerContent = isAnswer
      ? result.fullContent
      : context.task.fullContent;
    if (result.overspent) {
      return this.stopOnBudgetExceeded(
        context,
        input,
        result.overspent,
        answerContent,
      );
    }
    if (result.approvals.length > 0) {
      return this.createToolApprovalWait(
        context,
        input,
        result.approvals,
        answerContent,
      );
    }
    return this.completeNode(
      context,
      input,
      'default',
      isAnswer && result.fullContent ? '已生成回复' : '节点执行完成',
      {
        ...(isAnswer ? { fullContent: result.fullContent } : {}),
        outputs: { text: result.nodeText },
        ...(modelContext ? { modelContext } : {}),
      },
    );
  }

  /**
   * 为最终回答节点注入当前用户图片。
   * @param context 当前 Flow 执行上下文
   * @param modelPreset 回答节点锁定的模型预设 ID
   * @param messages 当前会话文字上下文
   * @returns 返回带公网图片 URL 的消息；K3 额外返回仅驻留内存的发包替换
   * @description 只修改最后一条 user 消息。历史图片不自动回放；Data URI 不进入消息状态，
   * 因而不会写进 LangGraph checkpoint、数据库、Redis 或 Temporal History。
   */
  private async prepareAnswerVision(
    context: AgentFlowExecutionContext,
    modelPreset: string,
    messages: LlmMessage[],
  ) {
    const transport = this.modelRegistry.getVisionTransport(modelPreset);
    if (!transport || !context.task.imageAssetId) {
      throw createNonRetryableActivityFailure(
        `回答节点模型「${modelPreset}」不支持图片输入`,
        'AGENT_FLOW_VISION_MODEL_UNSUPPORTED',
      );
    }
    const image = await this.storageAssetService.prepareChatImageForModel(
      context.task.userId,
      context.task.imageAssetId,
      transport,
    );
    const lastUserIndex = messages.findLastIndex(
      (message) => message.role === 'user',
    );
    if (lastUserIndex < 0) {
      throw createNonRetryableActivityFailure(
        '图片任务缺少当前用户消息',
        'AGENT_FLOW_TASK_SNAPSHOT_MISMATCH',
      );
    }
    const withImage = messages.map((message, index) =>
      index === lastUserIndex
        ? {
            ...message,
            content: context.task.inputText,
            image: { url: image.publicUrl, detail: 'auto' as const },
          }
        : message,
    );
    return {
      messages: withImage,
      ...(image.wireDataUri
        ? {
            transform: {
              sourceUrl: image.publicUrl,
              dataUri: image.wireDataUri,
            },
          }
        : {}),
    };
  }

  /**
   * 消费底层 Agent 的结构化事件流
   * @param context 当前节点执行上下文
   * @param input Temporal 节点执行标识
   * @param stream CommonChatAgentService 的事件流
   * @returns 返回累计正文、同一轮待审批工具请求批次，以及是否已突破预算
   * @description token 增量只写 Redis Frame；工具生命周期仍由 Flow 节点统一投影。LangGraph 同一轮 interrupt 可能含多个工具请求，必须完整消费并作为一个审批批次持久化，随后由 Temporal Workflow 等待同一个 approvalId。工具调用在此按 tool.call.start 计入预算，模型调用由调用方经 onModelTurn 计入。
   */
  private async consumeAgentStream(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    stream: AsyncGenerator<CommonChatAgentStreamEvent, void, unknown>,
    options: {
      initialContent: string;
      publishMessageDelta: boolean;
      budget: FlowBudgetTracker;
    },
  ): Promise<{
    fullContent: string;
    /** 只含本节点这一轮产出的正文，作为节点声明输出 text；fullContent 是任务累计正文 */
    nodeText: string;
    hadToolCalls: boolean;
    approvals: ApprovalRequiredPayload[];
    overspent: FlowBudgetDimension | null;
  }> {
    let fullContent = options.initialContent;
    let nodeText = '';
    let hadToolCalls = false;
    const approvals: ApprovalRequiredPayload[] = [];
    for await (const event of stream) {
      if (event.type === StreamTaskEventType.ToolCallStart) {
        // 只在 start 上计数：同一次工具调用还会产出 delta / done，重复计会虚高
        hadToolCalls = true;
        options.budget.countToolCall();
      }
      // 计数后立刻判定并 return：for-await 提前退出会对生成器调用 return()，
      // 从而中断底层 LangGraph 流，工具在本轮不会被真正执行。留到下一个事件再判
      // 会放过一次超额调用。
      const overspent = options.budget.overspent();
      if (overspent) {
        return {
          fullContent,
          nodeText,
          hadToolCalls,
          approvals,
          overspent,
        };
      }
      if (event.type === StreamTaskEventType.ToolCallStart) {
        continue;
      }
      if (event.type === StreamTaskEventType.MessageDelta) {
        fullContent += event.delta;
        nodeText += event.delta;
        if (options.publishMessageDelta) {
          await this.taskEventService.publishTransient(
            context.task.id,
            StreamTaskEventType.MessageDelta,
            JSON.stringify({
              type: StreamTaskEventType.MessageDelta,
              taskId: context.task.id,
              streamId: context.task.streamId ?? undefined,
              conversationId: context.task.conversationId,
              messageId: context.task.messageId,
              status: StreamTaskStatus.STREAMING.toLowerCase(),
              payload: { delta: event.delta },
            }),
          );
        }
        continue;
      }
      if (
        event.type === StreamTaskEventType.ToolCallDelta ||
        event.type === StreamTaskEventType.ToolCallDone ||
        event.type === StreamTaskEventType.ToolCallError
      ) {
        hadToolCalls = true;
        continue;
      }
      if (event.type === StreamTaskEventType.ApprovalRequired) {
        approvals.push(event.payload);
      }
    }
    return {
      fullContent,
      nodeText,
      hadToolCalls,
      approvals,
      overspent: options.budget.overspent(),
    };
  }

  /**
   * 创建或复用一个工具审批等待事实
   * @param context 当前节点执行上下文
   * @param input Temporal 节点执行标识
   * @param requests 同一轮底层 agent 产出的安全工具审批请求批次
   * @param fullContent 等待前累计的回复正文
   * @returns 返回 Workflow 可等待的稳定 approvalId
   * @description 审批、Flow waiting 事件、审批 trace 和 StreamTask.WAITING_HUMAN 在同一事务提交。Activity 重试命中同节点的 PENDING 审批时直接复用，避免重复卡片和重复 trace。
   */
  private async createToolApprovalWait(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    requests: ApprovalRequiredPayload[],
    fullContent: string,
    traceKey = createApprovalTraceKey(input.nodeExecutionId),
  ): Promise<AgentFlowNodeExecutionResult> {
    const allowedDecisions = resolveBatchAllowedDecisions(requests);
    const existing = await this.prisma.agentFlowApproval.findFirst({
      where: {
        taskId: context.task.id,
        nodeKey: context.node.key,
        kind: AgentFlowApprovalKind.TOOL,
        status: AgentFlowApprovalStatus.PENDING,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return {
        kind: 'waiting_human',
        approvalId: existing.id,
        timeoutSeconds: FLOW_APPROVAL_TIMEOUT_SECONDS,
      };
    }
    const expiresAt = new Date(
      Date.now() + FLOW_APPROVAL_TIMEOUT_SECONDS * 1_000,
    );
    const result = await this.prisma.$transaction(async (transaction) => {
      const approval = await transaction.agentFlowApproval.create({
        data: {
          taskId: context.task.id,
          runId: context.task.streamId,
          nodeKey: context.node.key,
          kind: AgentFlowApprovalKind.TOOL,
          requestSummary: toInputJsonValue({
            requests: requests.map((request) => ({
              toolName: request.toolName,
              ...(request.args ? { args: request.args } : {}),
              ...(request.description
                ? { description: request.description }
                : {}),
              index: request.index,
            })),
            allowedDecisions,
          }),
        },
      });
      const event = await this.taskEventService.persistInTransaction(
        transaction,
        {
          taskId: context.task.id,
          streamId: context.task.streamId,
          userId: context.task.userId,
          conversationId: context.task.conversationId,
          messageId: context.task.messageId,
          eventName: StreamTaskEventType.FlowWaitingHuman,
          status: StreamTaskStatus.WAITING_HUMAN,
          payload: {
            approvalId: approval.id,
            nodeKey: context.node.key,
            traceKey,
            approval: {
              kind: 'tool',
              requests: requests.map((request) => ({
                toolName: request.toolName,
                ...(request.args ? { args: request.args } : {}),
                ...(request.description
                  ? { description: request.description }
                  : {}),
                index: request.index,
              })),
              allowedDecisions,
            },
            expiresAt: expiresAt.toISOString(),
          },
          taskUpdate: {
            currentStep: context.node.key,
            fullContent,
            pausedAt: new Date(),
            expiresAt,
          },
        },
      );
      if (event.traceItemId) {
        await transaction.agentFlowApproval.update({
          where: { id: approval.id },
          data: { traceItemId: event.traceItemId },
        });
      }
      return { approvalId: approval.id, event };
    });
    await this.taskEventService.publishAfterCommit(result.event);
    return {
      kind: 'waiting_human',
      approvalId: result.approvalId,
      timeoutSeconds: FLOW_APPROVAL_TIMEOUT_SECONDS,
    };
  }

  /**
   * 持久化一个节点完成结果
   * @param context 当前节点执行上下文
   * @param input Temporal 节点执行标识
   * @param outcome Workflow 下一跳分支
   * @param summary 节点可展示的安全摘要
   * @param fullContent 当前累计回复正文
   * @returns 返回 Workflow 可直接推进的完成结果
   * @description 完成事实写入 `AgentFlowNodeExecution` 后，Activity retry 会回放同一 outcome 而不会重新调用模型或工具。
   * 该行与完成事件在同一事务内提交：事件已发出但幂等记录缺失，重试就会重复执行副作用。
   */
  private async completeNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    outcome: AgentFlowNodeCompletedResult['outcome'],
    summary: string,
    options: {
      fullContent?: string;
      outputs?: Record<string, unknown>;
      modelContext?: ModelContextEnvelope;
    } = {},
  ): Promise<AgentFlowNodeCompletedResult> {
    const event = await this.prisma.$transaction(async (transaction) => {
      await this.recordNodeExecutionInTransaction(transaction, context, input, {
        result: AgentFlowNodeExecutionResultKind.COMPLETED,
        outcome,
        summary,
        ...(options.outputs ? { outputs: options.outputs } : {}),
      });
      if (options.modelContext) {
        await transaction.message.update({
          where: { id: context.task.messageId },
          data: { modelContext: toInputJsonValue(options.modelContext) },
        });
      }
      return this.taskEventService.persistInTransaction(transaction, {
        taskId: context.task.id,
        streamId: context.task.streamId,
        userId: context.task.userId,
        conversationId: context.task.conversationId,
        messageId: context.task.messageId,
        eventName: StreamTaskEventType.FlowNodeCompleted,
        status: StreamTaskStatus.STREAMING,
        payload: {
          nodeKey: context.node.key,
          nodeType: context.node.type,
          traceKey: createNodeTraceKey(input.nodeExecutionId),
          summary,
          durationMs: 0,
        },
        taskUpdate: {
          currentStep: context.node.key,
          // 只有真正算出了正文才写：没算就回写快照里读到的旧值是 read-modify-write，
          // 并发节点之间会互相覆盖（现在写回的恰好是同一个旧值，但没有理由留这个形状）
          ...(options.fullContent === undefined
            ? {}
            : { fullContent: options.fullContent }),
          pausedAt: null,
        },
      });
    });
    await this.taskEventService.publishAfterCommit(event);
    return { kind: 'completed', outcome, summary };
  }

  /**
   * 在当前事务内登记一个节点执行的终局事实
   * @param transaction 当前 PostgreSQL 事务客户端
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param result 终局形态、分支键、摘要与失败类别
   * @returns 无返回值
   * @description 直接 create 而不 upsert：唯一键冲突说明另一次尝试已经写过同一节点，此时整个
   * 事务回滚、Temporal 重试、`replayFinishedNode` 命中已有结果，正是期望的收敛路径；
   * upsert 会掩盖这次并发并可能用后到的结果覆盖先落库的事实。
   */
  private async recordNodeExecutionInTransaction(
    transaction: Prisma.TransactionClient,
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    result: {
      result: AgentFlowNodeExecutionResultKind;
      outcome?: string;
      summary?: string;
      errorCategory?: TaskErrorCategory;
      outputs?: Record<string, unknown>;
    },
  ): Promise<void> {
    await transaction.agentFlowNodeExecution.create({
      data: {
        taskId: context.task.id,
        nodeExecutionId: input.nodeExecutionId,
        nodeKey: context.node.key,
        result: result.result,
        ...(result.outcome ? { outcome: result.outcome } : {}),
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.errorCategory
          ? { errorCategory: result.errorCategory }
          : {}),
        ...(result.outputs
          ? { outputs: toInputJsonValue(result.outputs) }
          : {}),
      },
    });
  }

  /**
   * 同步保存 PlanLoop 的步骤 checkpoint
   * @param context 当前编译后的节点执行上下文
   * @param state 已执行完成一个步骤后的完整 Flow 状态
   * @returns 无返回值
   * @description 每一步完成即同步更新 `StreamTask.executionState`，使 Activity retry 或 Worker 重启从下一步继续；该 checkpoint 不生成新的客户端语义事件，也不改变 Flow 节点的 trace 状态。
   */
  private async persistPlanLoopCheckpoint(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    planLoop: PersistedFlowPlanLoop,
  ): Promise<void> {
    await this.writeNodeState(context, input, planLoop);
    await this.prisma.streamTask.update({
      where: { id: context.task.id },
      data: { currentStep: context.node.key, lastHeartbeatAt: new Date() },
    });
  }

  /**
   * 在任务终态事务中收敛仍待处理的 Flow 审批及 trace
   * @param transaction 当前 PostgreSQL 事务客户端
   * @param taskId 当前 Flow 任务ID
   * @param status 审批应迁移到的不可逆终态
   * @param summary 写入审批 trace 的安全摘要
   * @returns 无返回值
   * @description 只更新 PENDING 审批，因此取消、超时或 Workflow retry 重复收尾均幂等；先读取关联 traceId，再在同一事务中把对应 RUNNING trace 标记为 ERROR，避免历史页面永久显示等待人工确认。
   */
  private async settlePendingApprovalsInTransaction(
    transaction: Prisma.TransactionClient,
    taskId: string,
    status: Extract<
      AgentFlowApprovalStatus,
      'CANCELED' | 'TIMED_OUT' | 'ERROR'
    >,
    summary: string,
  ): Promise<void> {
    const pendingApprovals = await transaction.agentFlowApproval.findMany({
      where: { taskId, status: AgentFlowApprovalStatus.PENDING },
      select: { id: true, traceItemId: true },
    });
    if (pendingApprovals.length === 0) {
      return;
    }
    await transaction.agentFlowApproval.updateMany({
      where: { taskId, status: AgentFlowApprovalStatus.PENDING },
      data: { status },
    });
    const traceItemIds = pendingApprovals
      .map((approval) => approval.traceItemId)
      .filter((traceItemId): traceItemId is string => Boolean(traceItemId));
    if (traceItemIds.length === 0) {
      return;
    }
    await transaction.conversationTurnTraceItem.updateMany({
      where: {
        id: { in: traceItemIds },
        status: ConversationTraceItemStatus.RUNNING,
      },
      data: {
        status: ConversationTraceItemStatus.ERROR,
        summary,
        error: { message: summary },
        endedAt: new Date(),
      },
    });
  }

  /**
   * 持久化一个正常结束但不再选择下一条边的节点结果
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param status Workflow 应收敛的终态
   * @param summary 节点与 trace 可展示的结束摘要
   * @param fullContent 可作为最终消息落库的安全正文
   * @param options 失败分类与已累计预算等可选收尾信息
   * @returns 返回要求 Workflow 直接收尾的结果
   * @description 用户主动终止计划属于已处理的业务结果，不应伪装成错误；状态写入 executionState 后，Activity retry 返回同一 stopped 结果而不会重复发送终止事件。status 为 error 时发 `flow.node.failed` 而不是 `flow.node.completed`，否则端侧只能从 run 级终态猜是哪个节点失败的。
   */
  private async stopNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    status: 'completed' | 'cancelled' | 'error',
    summary: string,
    fullContent: string,
    options: {
      errorCategory?: TaskErrorCategory;
    } = {},
  ): Promise<AgentFlowNodeExecutionResult> {
    const failed = status === 'error';
    const errorCategory = failed
      ? (options.errorCategory ?? 'unknown')
      : undefined;
    const traceKey = createNodeTraceKey(input.nodeExecutionId);
    const event = await this.prisma.$transaction(async (transaction) => {
      await this.recordNodeExecutionInTransaction(transaction, context, input, {
        result: STOPPED_RESULT_KIND[status],
        summary,
        ...(errorCategory ? { errorCategory } : {}),
      });
      return this.taskEventService.persistInTransaction(transaction, {
        taskId: context.task.id,
        streamId: context.task.streamId,
        userId: context.task.userId,
        conversationId: context.task.conversationId,
        messageId: context.task.messageId,
        ...(failed && errorCategory
          ? {
              eventName: StreamTaskEventType.FlowNodeFailed,
              status: StreamTaskStatus.STREAMING,
              payload: {
                nodeKey: context.node.key,
                title: getNodeTitle(context.node),
                nodeType: context.node.type,
                traceKey,
                category: errorCategory,
                // 预算耗尽与配置错误重试都不会变好；可重试类别由 LLM 错误分类单独判定
                retryable: false,
              },
            }
          : {
              eventName: StreamTaskEventType.FlowNodeCompleted,
              status: StreamTaskStatus.STREAMING,
              payload: {
                nodeKey: context.node.key,
                nodeType: context.node.type,
                traceKey,
                summary,
                durationMs: 0,
              },
            }),
        taskUpdate: {
          currentStep: context.node.key,
          fullContent,
          pausedAt: null,
        },
      });
    });
    await this.taskEventService.publishAfterCommit(event);
    return {
      kind: 'stopped',
      status,
      ...(errorCategory ? { errorCategory } : {}),
    };
  }

  /**
   * 读取一个引用指向的计划步骤
   * @param context 当前编译后的节点执行上下文
   * @param ref 指向某个上游节点 steps 输出的引用
   * @returns 返回该节点已落库的计划步骤
   * @description 发布期的 ref-dominates 已保证被引节点在每条路径上都必定先完成，因此这里读不到
   * 就是我们自己的写入漏了，显式失败而不是当作空计划——空计划会让 plan-loop 直接「完成 0 步」
   * 静默走完，用户拿到一个没干活的回答。
   */
  private async readPlanSteps(
    context: AgentFlowExecutionContext,
    ref: FlowRef,
  ): Promise<PlanStep[]> {
    const [sourceId] = ref.$ref;
    const outputs = (await this.loadUpstreamOutputs(context.task.id)).get(
      sourceId,
    );
    const steps = outputs ? readPlanStepsValue(outputs.steps) : undefined;
    if (!steps) {
      throw createNonRetryableActivityFailure(
        `节点「${context.node.key}」引用的计划「${sourceId}.steps」不可用`,
        'AGENT_FLOW_RUNTIME_CONTEXT_INVALID',
      );
    }
    return steps;
  }

  /**
   * 读取一个引用指向的字符串数组
   * @param context 当前编译后的节点执行上下文
   * @param ref 指向某个上游节点数组输出的引用
   * @returns 返回其中的字符串元素
   * @description 用于 synthesize 读取步骤观察。与计划不同，观察为空是合法的（步骤可能一条
   * 都没跑），因此读不到只退化为空数组而不失败。
   */
  private async readRefStringArray(
    context: AgentFlowExecutionContext,
    ref: FlowRef,
  ): Promise<string[]> {
    const [sourceId, field] = ref.$ref;
    const outputs = (await this.loadUpstreamOutputs(context.task.id)).get(
      sourceId,
    );
    const value = outputs?.[field];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  /**
   * 取出被审计划所属的已编译 plan 节点
   * @param context 当前编译后的节点执行上下文
   * @param ref 审批节点的 planRef
   * @returns 返回包含具体模型与步骤上限的编译节点
   * @description 打回重规划要沿用原 plan 节点的模型和步数上限。校验期的
   * approval-plan-source 规则已保证 planRef 指向 plan 节点，因此这里取不到就是快照损坏。
   */
  private readPlanNode(
    context: AgentFlowExecutionContext,
    ref: FlowRef,
  ): Extract<CompiledFlowNode, { type: 'plan' }> {
    const source = context.compiledPlan.nodes.find(
      (node) => node.key === ref.$ref[0],
    );
    if (source?.type !== 'plan') {
      throw createNonRetryableActivityFailure(
        '计划审批引用的不是 plan 节点',
        'AGENT_FLOW_INVALID_SNAPSHOT',
      );
    }
    return source;
  }

  /**
   * 读取审批节点自己的轮次状态
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @returns 返回修订轮次、累计反馈与本轮待审步骤
   * @description 首次进入时为空状态。steps 落在这里是必要的：打回重规划后的新计划由本节点
   * 产出，还没成为任何节点的输出，只能先存在自己的 scratch 里。
   */
  private async readApprovalScratch(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
  ): Promise<ApprovalScratch> {
    const state = await this.readNodeState(context.task.id, input);
    const steps = state ? readPlanStepsValue(state.steps) : undefined;
    return {
      revision: readNonNegativeInteger(state?.revision),
      feedback: Array.isArray(state?.feedback)
        ? state.feedback.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
      ...(steps ? { steps } : {}),
    };
  }

  /**
   * 读取 PlanLoop 节点自己的步骤进度
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @returns 返回步骤下标、已产出的观察与上一步是否调过工具
   * @description 首次进入时从零开始。这份状态只由本节点读写，因此并行节点之间不会互相覆盖。
   */
  private async readPlanLoopScratch(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
  ): Promise<PersistedFlowPlanLoop> {
    const state = await this.readNodeState(context.task.id, input);
    return {
      stepIndex: readNonNegativeInteger(state?.stepIndex),
      observations: Array.isArray(state?.observations)
        ? state.observations.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
      lastStepHadToolCalls: state?.lastStepHadToolCalls === true,
    };
  }

  /**
   * 读取一个节点的私有状态
   * @param taskId 当前任务标识
   * @param input Temporal 节点执行标识
   * @returns 有记录且为对象时返回它，否则返回 null
   */
  private async readNodeState(
    taskId: string,
    input: AgentFlowNodeExecutionInput,
  ): Promise<Prisma.JsonObject | null> {
    const row = await this.prisma.agentFlowNodeState.findUnique({
      where: {
        taskId_nodeExecutionId: {
          taskId,
          nodeExecutionId: input.nodeExecutionId,
        },
      },
      select: { state: true },
    });
    return row && isJsonObject(row.state) ? row.state : null;
  }

  /**
   * 覆盖写入一个节点的私有状态
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param state 该节点的完整私有状态
   * @returns 无返回值
   * @description upsert 而不是 create：这份状态在节点结束前会被反复更新（plan-loop 每步一次、
   * approval 每轮打回一次）。它与存终局事实的 AgentFlowNodeExecution 分表，正是为了让那张表
   * 保持「有行即已终结」，从而保住基于唯一键冲突的幂等收敛。
   */
  private async writeNodeState(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    state: Record<string, unknown>,
  ): Promise<void> {
    const value = toInputJsonValue(state);
    await this.prisma.agentFlowNodeState.upsert({
      where: {
        taskId_nodeExecutionId: {
          taskId: context.task.id,
          nodeExecutionId: input.nodeExecutionId,
        },
      },
      create: {
        taskId: context.task.id,
        nodeExecutionId: input.nodeExecutionId,
        nodeKey: context.node.key,
        state: value,
      },
      update: { state: value },
    });
  }

  /**
   * 为当前节点创建已接上原子落库的预算追踪器
   * @param context 当前编译后的节点执行上下文
   * @returns 返回可计数、判定与落库的追踪器
   * @description 上限来自冻结的 FlowDefinition，起始用量来自任务锁定时读到的计数列。
   * 落库走 Prisma 的 `increment`（SQL 层 `col = col + n`），并回读累加后的权威总量，
   * 因此并发节点各自记账不会互相覆盖。
   */
  private createBudgetTracker(
    context: AgentFlowExecutionContext,
  ): FlowBudgetTracker {
    return createBudgetTracker(
      context.definition.policy,
      context.task.budgetUsage,
      async (delta) => {
        const task = await this.prisma.streamTask.update({
          where: { id: context.task.id },
          data: {
            flowModelCalls: { increment: delta.modelCalls },
            flowToolCalls: { increment: delta.toolCalls },
          },
          select: { flowModelCalls: true, flowToolCalls: true },
        });
        return {
          modelCalls: task.flowModelCalls,
          toolCalls: task.flowToolCalls,
        };
      },
    );
  }

  /**
   * 因突破运行预算而终止当前节点与整条 Flow
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param state 当前 Flow 级状态
   * @param dimension 被突破的预算维度
   * @param fullContent 突破前已累计的安全正文，保留给用户已看到的部分
   * @returns 返回要求 Workflow 收敛为 error 的结果
   * @description 预算是安全护栏而非模型建议，命中即硬停：写入 budget_exceeded 分类，发
   * `flow.node.failed`，并保留已产出的正文不回滚，避免用户看到的内容凭空消失。
   * 用量本身由调用方在停止前 flush 到计数列，不随这里的状态一起写。
   */
  private async stopOnBudgetExceeded(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    dimension: FlowBudgetDimension,
    fullContent = context.task.fullContent,
  ): Promise<AgentFlowNodeExecutionResult> {
    return this.stopNode(
      context,
      input,
      'error',
      toBudgetExceededSummary(dimension, context.definition.policy),
      fullContent,
      { errorCategory: 'budget_exceeded' },
    );
  }
}

/**
 * 将完整 Definition 投影为 Workflow 可安全持有的最小快照
 * @param definition 已通过结构校验的不可变 FlowDefinition
 * @returns 返回节点推进、分支与时长组成的脱敏快照
 * @description 显式排除节点 config、Flow 名称、描述、layout 与所有任务输入，保证 Temporal History 不能复原会话、提示词或工具调用数据。
 */
function toRunSnapshot(definition: FlowDefinition): AgentFlowRunSnapshot {
  const incomingNodeKeys = new Set(definition.edges.map((edge) => edge.to));
  const entryNode = definition.nodes.find(
    (node) => !incomingNodeKeys.has(node.id),
  );
  if (!entryNode) {
    throw createNonRetryableActivityFailure(
      'FlowVersion 中缺少入口节点',
      'AGENT_FLOW_INVALID_SNAPSHOT',
    );
  }

  const nextByNodeKey = new Map<string, Record<string, string[]>>();
  const loopRegions = flowLoopRegions(definition.nodes, definition.edges);
  for (const edge of definition.edges) {
    const branches = nextByNodeKey.get(edge.from) ?? {};
    const branch = edge.when ?? 'default';
    // 同一分支键累积成数组：default 有多条出边即并行扇出。此前这里是直接赋值，
    // 第二条扇出边会静默覆盖第一条。
    branches[branch] = [...(branches[branch] ?? []), edge.to];
    nextByNodeKey.set(edge.from, branches);
  }

  return {
    entryNodeKey: entryNode.id,
    maxDurationSeconds: definition.policy.maxDurationSeconds,
    nodes: definition.nodes.map((node) => ({
      key: node.id,
      type: node.type,
      next: nextByNodeKey.get(node.id) ?? {},
      ...(node.type === 'join'
        ? { join: { waitFor: node.config.waitFor, policy: node.config.policy } }
        : {}),
      ...(node.type === 'loop'
        ? {
            loop: {
              body: [...(loopRegions.get(node.id)?.body ?? [])].sort(),
            },
          }
        : {}),
    })),
  };
}

/**
 * 构造 CapabilityResolver 所需的受限执行决策
 * @param node 已编译的 Agent 节点能力配置
 * @returns 返回固定来源的 ReAct 能力决策
 * @description Flow 编译已经确定模型、技能和工具组；这里只复用能力解析器，不触发策略选择或模型路由。
 */
function toFlowCapabilityDecision(
  node: Omit<CompiledAgentFlowNode, 'key' | 'type'>,
): AgentStrategyDecision {
  return {
    mode: AgentStrategyMode.ReAct,
    confidence: 1,
    reason: '由已发布 Flow 固定执行器配置',
    skills: [...node.skills],
    toolGroups: [...node.toolGroups],
    maxSteps: node.maxToolIterations,
    publicStatus: '执行流程节点',
    source: 'forced',
  };
}

/**
 * 为 synthesize 节点生成无工具的 Agent 执行器配置
 * @param modelPreset 当前任务锁定的 Agent 默认模型
 * @returns 返回可由 CommonChatAgentService 消费的最小执行器
 * @description 汇总节点不从 Flow JSON 获取工具或模型，固定使用任务创建时锁定的 Agent 默认模型并禁止工具调用。
 */
function toSynthesizeExecutor(
  modelPreset: string,
  reasoning?: import('@litter-bear/types').ReasoningSelection,
): Omit<CompiledAgentFlowNode, 'key' | 'type'> {
  return {
    modelPreset,
    reasoning,
    toolGroups: [],
    skills: [],
    maxToolIterations: 1,
    approvalToolNames: [],
  };
}

/**
 * 合并 Agent 基础提示词与能力追加提示词
 * @param agentSystemPrompt 任务 Agent 的基础系统提示词
 * @param additions 能力解析器生成的安全追加提示词
 * @returns 返回去除空白后的系统提示词
 * @description Flow 节点复用当前 Agent 身份提示词，但能力范围只由已编译的工具组和技能决定，不读取策略路由生成的提示词。
 */
function mergeSystemPrompt(
  agentSystemPrompt: string | null,
  additions: readonly string[],
): string | undefined {
  const base = agentSystemPrompt?.trim() || chatAgentCommonPrompt.trim();
  const prompt = [base, ...additions.map((item) => item.trim())]
    .filter((item) => item.length > 0)
    .join('\n\n');
  return prompt || undefined;
}

/**
 * 从持久化 JSON 读取计划步骤
 * @param value 已落库的 steps 值
 * @returns 形状合法时返回步骤数组，否则返回 undefined
 * @description 只接受服务器自己写入的步骤闭集，避免手工改过的 JSON 被解释为可执行计划。
 * 任一条目形状不对就整份判为不可用——半份计划比没有计划更危险。
 */
function readPlanStepsValue(value: unknown): PlanStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps: PlanStep[] = [];
  for (const item of value) {
    if (
      !isJsonObject(item as Prisma.JsonValue) ||
      typeof (item as { id?: unknown }).id !== 'string' ||
      typeof (item as { goal?: unknown }).goal !== 'string'
    ) {
      return undefined;
    }
    const entry = item as {
      id: string;
      goal: string;
      suggestedTools?: unknown;
    };
    const suggestedTools = Array.isArray(entry.suggestedTools)
      ? entry.suggestedTools.filter(
          (name): name is string => typeof name === 'string',
        )
      : undefined;
    steps.push({
      id: entry.id,
      goal: entry.goal,
      ...(suggestedTools && suggestedTools.length > 0
        ? { suggestedTools }
        : {}),
    });
  }
  return steps;
}

/**
 * 读取一个非负整数计数
 * @param value 未经校验的 JSON 值
 * @returns 合法时返回原值，否则返回 0
 */
function readNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/** 已被突破的预算维度，直接对应 FlowDefinition.policy 的字段名。 */
type FlowBudgetDimension = 'maxModelCalls' | 'maxToolCalls';

/** 一次 Activity 内的预算追踪器。 */
interface FlowBudgetTracker {
  countModelCall: () => void;
  countToolCall: () => void;
  /**
   * 把本次 Activity 新增的调用数原子累加到库里，并用返回的权威总量刷新基线
   * @description 刻意不并入节点完成事务：额度是真花掉的，节点写入失败或回滚不该让这笔消耗
   * 从账上消失——那是把护栏往松的方向改。刷新基线的副作用是同一个 Activity 内后续的
   * overspent 判定也能看到其他并行分支的消耗。
   */
  flush: () => Promise<void>;
  /**
   * 模型调用额度已用尽（用量 >= 上限）；发起新的模型调用前的准入检查
   * @description 只看模型维度：maxToolCalls 为 0 是合法配置（禁用工具的纯问答节点），
   * 若在此一并要求工具额度，这类 Flow 会一次都跑不起来。工具超支由 overspent 在流中拦。
   */
  modelCallExhausted: () => boolean;
  /** 任一维度已突破上限（用量 > 上限）；用于在流中途立即停止消费 */
  overspent: () => FlowBudgetDimension | null;
}

/**
 * 创建 Flow 预算追踪器
 * @param limits 已发布 FlowDefinition 冻结的预算上限
 * @param usage 任务锁定时从计数列读到的历史累计用量
 * @param persist 把增量原子累加进库并返回累加后权威总量的写入函数
 * @returns 返回可计数、判定与落库的追踪器
 * @description 区分两个判定是为了既不浪费额度也不超支：进入一次模型调用前用
 * modelCallExhausted 拦截（没额度就不该再调模型），流内则用 overspent，让最后一次允许的
 * 调用完整产出后再中断，而不是把额度内的回复截断在半句话。
 * 计数在内存里累积、由 flush 成批落库，是因为 onModelTurn 是流映射层的同步回调，
 * 改成异步会把每次模型轮次都卡在一次数据库写上。
 */
function createBudgetTracker(
  limits: { maxModelCalls: number; maxToolCalls: number },
  usage: PersistedFlowBudgetUsage,
  persist: (
    delta: PersistedFlowBudgetUsage,
  ) => Promise<PersistedFlowBudgetUsage>,
): FlowBudgetTracker {
  let persisted: PersistedFlowBudgetUsage = { ...usage };
  const pending: PersistedFlowBudgetUsage = { modelCalls: 0, toolCalls: 0 };
  const total = (): PersistedFlowBudgetUsage => ({
    modelCalls: persisted.modelCalls + pending.modelCalls,
    toolCalls: persisted.toolCalls + pending.toolCalls,
  });
  return {
    countModelCall: () => {
      pending.modelCalls += 1;
    },
    countToolCall: () => {
      pending.toolCalls += 1;
    },
    modelCallExhausted: () => total().modelCalls >= limits.maxModelCalls,
    overspent: () => {
      const current = total();
      if (current.modelCalls > limits.maxModelCalls) {
        return 'maxModelCalls';
      }
      if (current.toolCalls > limits.maxToolCalls) {
        return 'maxToolCalls';
      }
      return null;
    },
    flush: async () => {
      const delta = { ...pending };
      if (delta.modelCalls === 0 && delta.toolCalls === 0) {
        return;
      }
      // 先写成功再扣减 pending：写失败时增量必须留在待落库账上，否则这次消耗静默消失
      const next = await persist(delta);
      pending.modelCalls -= delta.modelCalls;
      pending.toolCalls -= delta.toolCalls;
      persisted = next;
    },
  };
}

/**
 * 生成预算终止的安全摘要
 * @param dimension 被突破的预算维度
 * @param limits 当前 Flow 的预算上限
 * @returns 返回可直接展示给用户的中文摘要
 * @description 只暴露维度与上限数值，不含提示词、工具入参或模型输出。
 */
function toBudgetExceededSummary(
  dimension: FlowBudgetDimension,
  limits: { maxModelCalls: number; maxToolCalls: number },
): string {
  return dimension === 'maxModelCalls'
    ? `已达到模型调用预算上限（${limits.maxModelCalls} 次），任务停止`
    : `已达到工具调用预算上限（${limits.maxToolCalls} 次），任务停止`;
}

/**
 * 求值一个条件分支
 * @param branch 声明的 case
 * @param resolve 把引用解析为运行时值的函数
 * @returns 命中该分支时返回 true
 * @description logic 决定聚合方式：and 全真、or 任一真。条件列表在 schema 层已保证非空，
 * 因此不存在「空条件恒真」这种意外命中。
 */
function evaluateConditionCase(
  branch: FlowConditionCase,
  resolve: (ref: readonly [string, string]) => unknown,
): boolean {
  const results = branch.conditions.map((predicate) =>
    evaluateConditionPredicate(predicate, resolve(predicate.ref.$ref)),
  );
  return branch.logic === 'and'
    ? results.every(Boolean)
    : results.some(Boolean);
}

/**
 * 求值一条条件判定
 * @param predicate 声明的判定
 * @param actual 被引变量的运行时值
 * @returns 判定成立时返回 true
 * @description 算子与被引类型的匹配、以及该不该带比较值，都已在发布期校验过，因此这里只按
 * 算子语义比较。运行时值的类型仍要显式检查：它来自库里的 JSON，形状不符时按不成立处理，
 * 而不是让 undefined 参与比较得出似是而非的结果。
 */
function evaluateConditionPredicate(
  predicate: FlowConditionPredicate,
  actual: unknown,
): boolean {
  const { operator, value } = predicate;
  switch (operator) {
    case 'is':
      return typeof actual === 'string' && actual === value;
    case 'isNot':
      return typeof actual === 'string' && actual !== value;
    case 'startsWith':
      return (
        typeof actual === 'string' &&
        typeof value === 'string' &&
        actual.startsWith(value)
      );
    case 'endsWith':
      return (
        typeof actual === 'string' &&
        typeof value === 'string' &&
        actual.endsWith(value)
      );
    case 'contains':
      return containsValue(actual, value);
    case 'notContains':
      return isStringOrArray(actual) && !containsValue(actual, value);
    case 'empty':
      return isStringOrArray(actual) && actual.length === 0;
    case 'notEmpty':
      return isStringOrArray(actual) && actual.length > 0;
    case 'eq':
      return typeof actual === 'number' && actual === value;
    case 'ne':
      return typeof actual === 'number' && actual !== value;
    case 'gt':
      return typeof actual === 'number' && typeof value === 'number'
        ? actual > value
        : false;
    case 'lt':
      return typeof actual === 'number' && typeof value === 'number'
        ? actual < value
        : false;
    case 'gte':
      return typeof actual === 'number' && typeof value === 'number'
        ? actual >= value
        : false;
    case 'lte':
      return typeof actual === 'number' && typeof value === 'number'
        ? actual <= value
        : false;
    case 'isTrue':
      return actual === true;
    case 'isFalse':
      return actual === false;
    case 'lengthEq':
      return Array.isArray(actual) && actual.length === value;
  }
}

/**
 * 判断值是否为字符串或数组
 * @param value 待检查的运行时值
 * @returns 是字符串或数组时返回 true
 * @description 这两类共享 length 与 contains 语义，收敛成一个守卫避免两处各写一遍。
 */
function isStringOrArray(value: unknown): value is string | unknown[] {
  return typeof value === 'string' || Array.isArray(value);
}

/**
 * 判断字符串或数组是否包含目标值
 * @param actual 被引变量的运行时值
 * @param value 声明的比较值
 * @returns 包含时返回 true
 * @description 数组用严格相等匹配元素，因此对「工具名数组包含某工具」这类判定有意义；
 * 对象元素不会被结构比较，这与 FLOW_NODE_OUTPUTS 里数组输出的实际用法一致。
 */
function containsValue(actual: unknown, value: unknown): boolean {
  if (typeof actual === 'string') {
    return typeof value === 'string' && actual.includes(value);
  }
  return Array.isArray(actual) && actual.some((item) => item === value);
}

/**
 * 把 PlanLoop 进度投影为节点声明输出
 * @param planLoop 当前步骤进度与观察摘要
 * @returns 返回 FLOW_NODE_OUTPUTS 为 plan-loop 声明的输出对象
 * @description text 取最后一步的观察：下游 synthesize 已经单独读全量 observations，
 * 而条件判定通常只关心「最后一步说了什么」。
 */
function toPlanLoopOutputs(
  planLoop: PersistedFlowPlanLoop,
): Record<string, unknown> {
  return {
    text: planLoop.observations[planLoop.observations.length - 1] ?? '',
    observations: planLoop.observations,
  };
}

/** 终止语义到落库枚举的映射；两侧都是闭集，编译器强制补齐。 */
const STOPPED_RESULT_KIND: Readonly<
  Record<'completed' | 'cancelled' | 'error', AgentFlowNodeExecutionResultKind>
> = {
  completed: AgentFlowNodeExecutionResultKind.STOPPED_COMPLETED,
  cancelled: AgentFlowNodeExecutionResultKind.STOPPED_CANCELLED,
  error: AgentFlowNodeExecutionResultKind.STOPPED_ERROR,
};

/** 落库枚举回到 Workflow 终止语义的映射。 */
const STOPPED_RESULT_STATUS: Readonly<
  Record<
    Exclude<AgentFlowNodeExecutionResultKind, 'COMPLETED'>,
    'completed' | 'cancelled' | 'error'
  >
> = {
  STOPPED_COMPLETED: 'completed',
  STOPPED_CANCELLED: 'cancelled',
  STOPPED_ERROR: 'error',
};

/**
 * 把已落库的节点执行事实回放为 Workflow 结果
 * @param execution 从 AgentFlowNodeExecution 读到的终局记录
 * @param branchKeys 该节点在 Definition 里声明的合法分支键
 * @returns 返回 Workflow 可直接推进的完成或停止结果
 * @description outcome 与 errorCategory 都是库里的字符串列（闭集在 TypeScript 侧，做成
 * Prisma enum 会让同一个闭集有两个源），因此读取时必须收窄。分支键泛化后不再有全局闭集，
 * 判据改为「是否为该节点声明的分支」。COMPLETED 的 outcome 不合法时明确失败，不回退到
 * 'default'——猜一条边会让 Flow 静默走错路径。
 */
function toReplayedNodeResult(
  execution: {
    result: AgentFlowNodeExecutionResultKind;
    outcome: string | null;
    summary: string | null;
    errorCategory: string | null;
  },
  branchKeys: readonly string[],
): AgentFlowNodeExecutionResult {
  if (execution.result === AgentFlowNodeExecutionResultKind.COMPLETED) {
    const outcome = execution.outcome;
    if (!outcome || !branchKeys.includes(outcome)) {
      throw createNonRetryableActivityFailure(
        'Flow 节点完成记录缺少合法分支',
        'AGENT_FLOW_INVALID_SNAPSHOT',
      );
    }
    return { kind: 'completed', outcome, summary: execution.summary ?? '' };
  }
  const errorCategory = toTaskErrorCategory(
    execution.errorCategory ?? undefined,
  );
  return {
    kind: 'stopped',
    status: STOPPED_RESULT_STATUS[execution.result],
    ...(errorCategory ? { errorCategory } : {}),
  };
}

/**
 * 将人工编辑后的计划步骤归一化
 * @param editedSteps 计划审批决定提交的可选步骤列表
 * @returns 返回后端重新编号后的步骤列表
 * @description 只保留非空 goal，并由服务端重新分配稳定 step-N 标识；客户端不能指定步骤 ID 或工具范围。
 */
function toEditedPlanSteps(
  editedSteps: PlanReviewDecision['editedSteps'],
): PlanStep[] {
  return (editedSteps ?? [])
    .map((item) => item.goal.trim())
    .filter((goal) => goal.length > 0)
    .map((goal, index) => ({ id: `step-${index + 1}`, goal }));
}

/**
 * 从已持久化 JSON 解析计划审批决定
 * @param value AgentFlowApproval.decision 的 JSON 值
 * @returns 返回合法计划决定；格式异常时返回 undefined
 * @description 计划审批与工具审批的决定闭集不同，必须在恢复 Activity 中分开解析，避免 reject_replan 被错误交给工具 HITL Command。
 */
function toPlanReviewDecision(
  value: Prisma.JsonValue | null,
): PlanReviewDecision | undefined {
  if (!isJsonObject(value) || typeof value.decision !== 'string') {
    return undefined;
  }
  if (value.decision === 'approve' || value.decision === 'reject_terminate') {
    return { decision: value.decision };
  }
  if (value.decision === 'reject_replan') {
    return {
      decision: 'reject_replan',
      ...(typeof value.feedback === 'string'
        ? { feedback: value.feedback }
        : {}),
    };
  }
  if (value.decision === 'edit') {
    const rawSteps = value.editedSteps;
    const editedSteps: { goal: string }[] = [];
    if (Array.isArray(rawSteps)) {
      for (const item of rawSteps) {
        if (!isJsonObject(item) || typeof item.goal !== 'string') {
          return undefined;
        }
        editedSteps.push({ goal: item.goal });
      }
    }
    return {
      decision: 'edit',
      ...(Array.isArray(rawSteps) ? { editedSteps } : {}),
    };
  }
  return undefined;
}

/**
 * 筛选当前计划步骤可见的工具
 * @param tools 已由能力解析器装配的工具集
 * @param suggestedTools 当前步骤可选的工具名称
 * @returns 返回当前步骤可见的工具集
 * @description 计划未指定工具时保留完整闭集；指定后仅保留命名匹配项，避免一个步骤顺手执行后续步骤的外部动作。
 */
function filterToolsForPlanStep(
  tools: unknown[],
  suggestedTools: string[] | undefined,
): unknown[] {
  if (!suggestedTools?.length) {
    return tools;
  }
  const allowed = new Set(suggestedTools);
  return tools.filter((tool) => {
    if (!tool || typeof tool !== 'object') {
      return false;
    }
    const name = (tool as { name?: unknown }).name;
    return typeof name === 'string' && allowed.has(name);
  });
}

/**
 * 筛选当前计划步骤仍需 HITL 的工具名
 * @param approvalToolNames 该 PlanLoop 执行器的审批工具闭集
 * @param suggestedTools 当前步骤可选的工具名称
 * @returns 返回当前步骤实际可见工具对应的审批名称
 * @description 与工具筛选使用同一个 suggestedTools 条件，防止被隐藏的工具仍触发无对应调用的审批中断。
 */
function filterApprovalToolsForPlanStep(
  approvalToolNames: readonly string[],
  suggestedTools: string[] | undefined,
): string[] {
  if (!suggestedTools?.length) {
    return [...approvalToolNames];
  }
  const allowed = new Set(suggestedTools);
  return approvalToolNames.filter((name) => allowed.has(name));
}

/**
 * 构造 PlanLoop 内单步骤 Agent 的稳定执行标识
 * @param nodeExecutionId Flow 节点的稳定执行标识
 * @param stepId 计划步骤的服务端编号
 * @returns 返回子 Agent/HITL checkpoint 使用的 threadId
 * @description 一个 PlanLoop 会执行多个步骤，每步必须有独立 LangGraph checkpoint 和审批 trace，避免不同步骤的工具审批相互恢复到错误位置。
 */
function createPlanStepExecutionId(
  nodeExecutionId: string,
  stepId: string,
): string {
  return `${nodeExecutionId}:step:${stepId}`;
}

/**
 * 将持久化 JSON 解析为工具审批决定
 * @param value AgentFlowApproval.decision 的 JSON 值
 * @returns 返回合法工具审批决定；格式异常时返回 undefined
 * @description 只接受工具审批的 approve/reject/edit 闭集，计划审批不会被误送进 CommonChatAgentService 的 HITL Command。
 */
function toApprovalDecision(
  value: Prisma.JsonValue | null,
): ApprovalDecision | undefined {
  if (!isJsonObject(value) || typeof value.decision !== 'string') {
    return undefined;
  }
  if (value.decision === 'approve') {
    return { decision: 'approve' };
  }
  if (value.decision === 'reject') {
    return {
      decision: 'reject',
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    };
  }
  if (value.decision === 'edit') {
    return {
      decision: 'edit',
      ...(isJsonObject(value.editedArgs)
        ? { editedArgs: toUnknownRecord(value.editedArgs) }
        : {}),
    };
  }
  return undefined;
}

/**
 * 计算一组工具请求可共同提交的审批决定
 * @param requests 同一轮 LangGraph interrupt 产出的工具审批请求
 * @returns 返回所有请求均允许的决定集合
 * @description 恢复时一个 ApprovalDecision 会被 `buildHitlResponse` 应用于整批 actionRequests，因此只向客户端暴露交集，避免对部分工具不合法的 edit 决定。
 */
function resolveBatchAllowedDecisions(
  requests: ApprovalRequiredPayload[],
): ApprovalRequiredPayload['allowedDecisions'] {
  const firstRequest = requests[0];
  if (!firstRequest) {
    return [];
  }
  const commonDecisions = firstRequest.allowedDecisions.filter((decision) =>
    requests.every((request) => request.allowedDecisions.includes(decision)),
  );
  return requests.length > 1
    ? commonDecisions.filter((decision) => decision !== 'edit')
    : commonDecisions;
}

/**
 * 将受限 JSON 对象转换为工具入参记录
 * @param value 已验证为 JSON 对象的值
 * @returns 返回不含原型链的普通记录
 * @description 仅用于把审批事实中的 editedArgs 交给既有 HITL 恢复 API；值仍来自已持久化并经 DTO 验证的决定。
 */
function toUnknownRecord(value: Prisma.JsonObject): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

/**
 * 从任务请求 JSON 中读取一个字符串字段
 * @param value StreamTask.requestPayload 的 JSON 值
 * @param key 允许读取的顶层固定字段名
 * @returns 返回非空字符串；不存在或格式错误时返回 undefined
 * @description 只读取任务创建期冻结的用户凭据标识，不读取或解析任意嵌套对象。
 */
function readJsonString(
  value: Prisma.JsonValue,
  key: string,
): string | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/**
 * 判断值是否为 Prisma 支持的 JSON 对象
 * @param value 待检查的 JSON 值
 * @returns 值为非数组对象时返回 true
 * @description 用于收敛历史 executionState 和审批 JSON，避免 `null`、数组或标量被当作有字段的对象读取。
 */
function isJsonObject(
  value: Prisma.JsonValue | null | undefined,
): value is Prisma.JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从节点执行标识读取 Workflow 已冻结的循环轮次
 * @param nodeExecutionId 形如 `task:version:node#12` 的稳定节点执行标识
 * @returns 返回非负整数轮次；没有轮次段的部署前历史标识按第 0 轮处理
 * @description 只用于比较已完成行的新旧，不参与当前 Activity 的轮次决策。当前轮次必须由
 * Workflow 直接下传，不能从数据库记录推算，否则 Temporal 重试会绕过幂等短路。
 */
function readNodeExecutionIteration(nodeExecutionId: string): number {
  const match = /#(\d+)$/.exec(nodeExecutionId);
  if (!match) {
    return 0;
  }
  const iteration = Number(match[1]);
  return Number.isSafeInteger(iteration) ? iteration : 0;
}

/**
 * 将普通值转换为 Prisma JSON 输入
 * @param value 已由服务端构造的安全对象
 * @returns 返回独立的 Prisma JSON 值
 * @description JSON 往返移除 undefined，确保审批请求摘要不会因运行时对象或可选字段破坏数据库写入。
 */
function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * 获取 Flow 节点的展示标题
 * @param node 已编译的当前节点
 * @returns 返回面向 trace 和 SSE 的标题
 * @description 有别名就用别名，否则回退到节点类型标题。别名是管理员为这张图里的这个节点起的
 * 名字（如「人工确认退款」），比通用的类型标题（「等待计划确认」）更能说明它在做什么。
 * 别名由发布期校验限长，且不含配置、提示词或工具参数，可以安全进 trace 与 SSE。
 */
function getNodeTitle(node: Pick<CompiledFlowNode, 'name' | 'type'>): string {
  return node.name ?? getNodeTypeTitle(node.type);
}

/**
 * 获取 Flow 节点类型的公共展示标题
 * @param type 当前节点类型
 * @returns 返回面向 trace 和 SSE 的中文标题
 * @description 标题只反映节点类型，不包含 Flow 配置、提示词或工具原始参数。
 */
function getNodeTypeTitle(type: FlowNodeType): string {
  switch (type) {
    case 'agent':
      return '执行智能体节点';
    case 'plan':
      return '生成执行计划';
    case 'plan-loop':
      return '执行计划步骤';
    case 'approval':
      return '等待计划确认';
    case 'synthesize':
      return '汇总最终回复';
    case 'condition':
      return '判定条件分支';
    case 'start':
      return '开始';
    case 'end':
      return '结束';
    case 'join':
      return '汇聚并行分支';
    case 'loop':
      return '判定是否继续循环';
  }
}

/**
 * 创建节点生命周期的稳定 traceKey
 * @param nodeExecutionId Temporal 计算出的稳定节点执行标识
 * @returns 返回节点 start/done/fail 共用的 traceKey
 * @description task、版本和节点键已编码进 executionId；不额外加入用户正文或动态参数，保证重放和 retry 时仍命中同一条 trace。
 */
function createNodeTraceKey(nodeExecutionId: string): string {
  return `flow:node:${nodeExecutionId}`;
}

/**
 * 创建 Flow 审批 traceKey
 * @param nodeExecutionId Temporal 计算出的稳定节点执行标识
 * @returns 返回审批等待与决策收敛共用的 traceKey
 * @description 工具审批从所属节点派生，避免相同工具名在不同 Flow 节点或不同任务中发生 trace 归并冲突。
 */
function createApprovalTraceKey(nodeExecutionId: string): string {
  return `flow:approval:${nodeExecutionId}`;
}

/**
 * 创建计划审批 traceKey
 * @param nodeExecutionId Temporal 计算出的稳定节点执行标识
 * @param revision 当前计划修订轮次
 * @returns 返回同一计划轮次等待与决策收敛共用的 traceKey
 * @description 每次 reject_replan 都会生成新计划审批事实；将 revision 编码进 traceKey，避免新一轮等待复用已完成的上一轮审批 trace。
 */
function createPlanReviewTraceKey(
  nodeExecutionId: string,
  revision: number,
): string {
  return `flow:approval:${nodeExecutionId}:plan-review:${revision}`;
}

/**
 * 判断 StreamTask 是否已进入终态
 * @param status 当前任务状态
 * @returns 任务不可再被 Flow finalizer 更新时返回 true
 * @description 与 StreamTaskService 的终态集合保持一致，避免 Workflow retry 在用户取消或已有错误后覆盖最终状态。
 */
function isTerminalTaskStatus(status: StreamTaskStatus): boolean {
  return (
    status === StreamTaskStatus.COMPLETED ||
    status === StreamTaskStatus.ERROR ||
    status === StreamTaskStatus.EXPIRED ||
    status === StreamTaskStatus.CANCELED
  );
}

/**
 * 将已终态的 StreamTask 映射为 Workflow 不应继续执行的节点结果
 * @param status 当前任务状态
 * @returns 任务仍可执行时返回 undefined；终态时返回对应 stopped 结果
 * @description HTTP 取消与 Workflow 的取消 Signal 存在短暂交错窗口。Activity 每次开始和恢复都先检查数据库终态，确保即使 Signal 延迟或 API 进程重启，也不会继续模型调用或外部工具。
 */
function toTerminalNodeResult(
  status: StreamTaskStatus,
): AgentFlowNodeExecutionResult | undefined {
  if (status === StreamTaskStatus.CANCELED) {
    return { kind: 'stopped', status: 'cancelled' };
  }
  if (
    status === StreamTaskStatus.COMPLETED ||
    status === StreamTaskStatus.ERROR ||
    status === StreamTaskStatus.EXPIRED
  ) {
    return {
      kind: 'stopped',
      status: status === StreamTaskStatus.COMPLETED ? 'completed' : 'error',
    };
  }
  return undefined;
}

/**
 * 创建不会触发 Temporal Activity retry 的业务失败
 * @param message 可安全记录的错误说明
 * @param type 固定错误类别
 * @returns 返回带 nonRetryable 标记的 Temporal ApplicationFailure
 * @description 版本快照损坏、上下文缺失、审批格式异常和未接入节点不能通过重复调用修复，必须直接交给管理端或后续阶段的补偿流程处理。
 */
function createNonRetryableActivityFailure(
  message: string,
  type: string,
): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, type);
}

/**
 * 将 Agent 节点的模型超时转换为不会重复整轮 Activity 的安全失败
 * @param error LangChain 或模型 SDK 抛出的原始错误
 * @returns 非超时错误保持原样；该返回仅用于满足 throw 表达式的类型
 * @description AgentFlow 已允许 LangChain 在同一次模型请求内补试一次。若补试仍超时，
 * 再交给 Temporal 重跑整个节点会重复消息生成甚至工具循环，并把 30 秒故障放大到数分钟。
 * OpenAI SDK 在外部 timeout signal 触发时会使用 “Request was aborted.”，而 AgentFlow
 * 不向模型传用户取消 signal，因此这里可明确把该文案归为请求超时。
 */
function toAgentFlowModelFailure(error: unknown): unknown {
  const classified = classifyLlmError(error);
  const abortedByModelTimeout =
    classified.category === 'unknown' &&
    error instanceof Error &&
    error.message.trim().toLowerCase() === 'request was aborted.';
  if (classified.category === 'timeout' || abortedByModelTimeout) {
    return ApplicationFailure.nonRetryable(
      '模型响应超时，请重试',
      'AGENT_FLOW_LLM_TIMEOUT',
    );
  }
  return error;
}

/**
 * 判断当前节点是否产出这条助手消息的正文
 * @param context 当前节点执行上下文
 * @returns 返回该节点是否直接连接唯一 end
 * @description `task.fullContent` 与助手消息本质是**一段线性文本**，只能有一个生产者。
 * 因此约定：只有直接连接 end 的 agent/synthesize 吐字并写正文；中间 agent 节点静默执行，产出进
 * `outputs.text` 供下游 `$ref` 引用——这正是 plan-loop 步骤今天的行为。
 *
 * 没有这条约定，并行分支里的两个 agent 节点会把 token 交错写进同一段正文，且各自写一次
 * `fullContent` 后互相覆盖。那不是渲染问题，是数据被写坏。
 *
 * 判定用 Definition 的边而不是编译节点：end 是契约强制的唯一收口点，直接前驱正好对应
 * schemaVersion 6 及以前的“无出边回复节点”。互斥的多个前驱都会吐字，但只有一个会执行；
 * 「两个可能并发的回复节点」由 concurrent-answer-nodes 校验规则在保存期拦掉。
 */
function isAnswerNode(context: AgentFlowExecutionContext): boolean {
  const endIds = new Set(
    context.definition.nodes
      .filter((node) => node.type === 'end')
      .map((node) => node.id),
  );
  return context.definition.edges.some(
    (edge) => edge.from === context.node.key && endIds.has(edge.to),
  );
}
