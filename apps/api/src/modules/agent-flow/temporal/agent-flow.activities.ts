import { Inject, Injectable } from '@nestjs/common';
import {
  AgentFlowApprovalKind,
  AgentFlowApprovalStatus,
  ConversationTraceItemStatus,
  MessageStatus,
  Prisma,
  StreamTaskRunStatus,
  StreamTaskStatus,
} from '@prisma/client';
import { ApplicationFailure } from '@temporalio/client';
import type {
  FlowDefinition,
  FlowNodeType,
} from '@litter-bear/types/agent-flow';
import {
  AgentStrategyMode,
  StreamTaskEventType,
  type ApprovalDecision,
  type ApprovalRequiredPayload,
  type PlanReviewDecision,
} from '@litter-bear/types/protocol';
import { chatAgentCommonPrompt } from '../../../prompts';
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
import { validateFlowDefinition } from '../definition/flow-definition.validator';
import { FlowCompiler } from '../runtime/flow-compiler.service';
import type {
  CompiledAgentFlowNode,
  CompiledFlowNode,
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

interface PersistedCompletedNode {
  outcome: AgentFlowNodeCompletedResult['outcome'];
  summary: string;
}

/** Flow 计划节点写入的可恢复计划状态。 */
interface PersistedFlowPlan {
  steps: PlanStep[];
  fromModel: boolean;
  maxSteps: number;
  revision: number;
  feedback: string[];
}

/** Flow PlanLoop 节点写入的可恢复步骤进度。 */
interface PersistedFlowPlanLoop {
  stepIndex: number;
  observations: string[];
  lastStepHadToolCalls: boolean;
}

interface PersistedFlowExecutionState {
  started: boolean;
  completedNodes: Record<string, PersistedCompletedNode>;
  stoppedNodes: Record<
    string,
    { status: 'completed' | 'cancelled' | 'error'; errorCategory?: string }
  >;
  plan?: PersistedFlowPlan;
  planLoop?: PersistedFlowPlanLoop;
  pendingApproval?: {
    nodeExecutionId: string;
    approvalId: string;
  };
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
    executionState: Prisma.JsonValue | null;
    flowVersionId: string;
    flowDigest: string;
  };
  flowId: string;
  definition: FlowDefinition;
  node: CompiledFlowNode;
  agentModelPreset: string;
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
   * @description 从冻结 FlowVersion 重新编译当前节点，不进入 StrategyRouter。已完成和待审批节点从 StreamTask.executionState 读取幂等结果；新执行先写 `flow.node.started`，再消费底层 agent 事件。
   */
  async executeNode(
    input: AgentFlowNodeExecutionInput,
  ): Promise<AgentFlowNodeExecutionResult> {
    const context = await this.loadExecutionContext(input);
    const terminalResult = toTerminalNodeResult(context.task.status);
    if (terminalResult) {
      return terminalResult;
    }
    const state = readFlowExecutionState(context.task.executionState);
    const completed = state.completedNodes[input.nodeExecutionId];
    if (completed) {
      return { kind: 'completed', ...completed };
    }
    const stopped = state.stoppedNodes[input.nodeExecutionId];
    if (stopped) {
      return { kind: 'stopped', ...stopped };
    }
    if (
      state.pendingApproval?.nodeExecutionId === input.nodeExecutionId &&
      state.pendingApproval.approvalId
    ) {
      return {
        kind: 'waiting_human',
        approvalId: state.pendingApproval.approvalId,
        timeoutSeconds: FLOW_APPROVAL_TIMEOUT_SECONDS,
      };
    }

    await this.emitRunAndNodeStarted(context, input.nodeExecutionId, state);
    return this.executeCompiledNode(context, input, undefined);
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
    const errorMessage = completed
      ? undefined
      : cancelled
        ? '流程已取消'
        : '流程执行失败';
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
                  category: 'server',
                  retryable: false,
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
        executionState: true,
        requestPayload: true,
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
    const agent = await this.prisma.agent.findUnique({
      where: { id: task.agentId },
      select: { modelPreset: true, systemPrompt: true },
    });
    if (!agent?.modelPreset) {
      throw createNonRetryableActivityFailure(
        'Flow 任务未锁定智能体默认模型',
        'AGENT_FLOW_RUNTIME_CONTEXT_INVALID',
      );
    }
    const mcdonaldsCredentialId = readJsonString(
      task.requestPayload,
      'mcdonaldsCredentialId',
    );
    const compiled = this.flowCompiler.compile(parsed.definition, {
      agentDefaultModelPreset: agent.modelPreset,
      ...(mcdonaldsCredentialId ? { mcdonaldsCredentialId } : {}),
    });
    if (!compiled.success) {
      throw createNonRetryableActivityFailure(
        'Flow 任务期能力校验失败',
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
        executionState: task.executionState,
        flowVersionId: task.flowVersionId,
        flowDigest: task.flowDigest,
      },
      flowId: task.flowVersion.flowId,
      definition: parsed.definition,
      node,
      agentModelPreset: agent.modelPreset,
      agentSystemPrompt: agent.systemPrompt,
      ...(mcdonaldsCredentialId ? { mcdonaldsCredentialId } : {}),
    };
  }

  /**
   * 写入 Flow 运行开始和节点开始事件
   * @param context 当前编译后的节点执行上下文
   * @param nodeExecutionId 稳定节点执行标识
   * @param state 当前已持久化 Flow 运行状态
   * @returns 无返回值
   * @description 首次节点前写 `flow.run.started`，每个节点写 `flow.node.started`。两个事件在同一事务内递增语义 eventId，事务提交后依序追加 Redis 帧。
   */
  private async emitRunAndNodeStarted(
    context: AgentFlowExecutionContext,
    nodeExecutionId: string,
    state: PersistedFlowExecutionState,
  ): Promise<void> {
    const events = await this.prisma.$transaction(async (transaction) => {
      const persisted: PersistedAgentFlowTaskEvent[] = [];
      const nextState = { ...state, started: true };
      if (!state.started) {
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
              executionState: toFlowExecutionState(nextState),
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
            title: getNodeTitle(context.node.type),
            traceKey: createNodeTraceKey(nodeExecutionId),
          },
          taskUpdate: {
            currentStep: context.node.key,
            executionState: toFlowExecutionState(nextState),
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
   * @description V1 先启用可独立执行的 agent、synthesize 和 condition。plan/plan-loop/approval 需要独立状态机执行器，当前明确失败而不复用整张旧策略图造成重复规划或越权执行。
   */
  private async executeCompiledNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    resumeDecision: ApprovalDecision | PlanReviewDecision | undefined,
  ): Promise<AgentFlowNodeExecutionResult> {
    if (context.node.type === 'condition') {
      const state = readFlowExecutionState(context.task.executionState);
      const outcome = evaluateCondition(context.node.condition, state)
        ? 'true'
        : 'false';
      return this.completeNode(context, input, outcome, '条件判断已完成');
    }
    if (context.node.type === 'agent') {
      return this.executeAgentNode(
        context,
        input,
        context.node,
        resumeDecision as ApprovalDecision | undefined,
      );
    }
    if (context.node.type === 'synthesize') {
      return this.executeSynthesizeNode(context, input, resumeDecision);
    }
    if (context.node.type === 'plan') {
      return this.executePlanNode(context, input, context.node.maxSteps);
    }
    if (context.node.type === 'approval') {
      return this.executePlanReviewNode(
        context,
        input,
        resumeDecision as PlanReviewDecision | undefined,
      );
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
   * @param maxSteps 当前计划节点声明的步骤预算
   * @returns 返回已持久化计划后的默认完成分支
   * @description 规划使用既有 PlannerService 的结构化输出与单步降级语义；计划正文只写入任务执行状态，绝不进入客户端消息增量或 Temporal History。
   */
  private async executePlanNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    maxSteps: number,
  ): Promise<AgentFlowNodeCompletedResult> {
    const state = readFlowExecutionState(context.task.executionState);
    const plan = await this.createPlan(context, maxSteps, []);
    const nextState: PersistedFlowExecutionState = {
      ...state,
      plan: {
        steps: plan.steps,
        fromModel: plan.fromModel,
        maxSteps,
        revision: 0,
        feedback: [],
      },
      planLoop: undefined,
    };
    return this.completeNode(
      context,
      input,
      'default',
      `已生成 ${plan.steps.length} 个计划步骤`,
      context.task.fullContent,
      nextState,
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
    decision: PlanReviewDecision | undefined,
  ): Promise<AgentFlowNodeExecutionResult> {
    const state = readFlowExecutionState(context.task.executionState);
    const plan = requirePersistedPlan(state);
    if (!decision) {
      return this.createPlanReviewApprovalWait(context, input, state);
    }

    if (decision.decision === 'approve') {
      return this.completeNode(context, input, 'approved', '计划已确认');
    }
    if (decision.decision === 'edit') {
      const steps = toEditedPlanSteps(decision.editedSteps);
      const nextState: PersistedFlowExecutionState = {
        ...state,
        plan: {
          ...plan,
          steps,
          fromModel: false,
        },
        planLoop: undefined,
      };
      return this.completeNode(
        context,
        input,
        'approved',
        `已确认修改后的 ${steps.length} 个计划步骤`,
        context.task.fullContent,
        nextState,
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
    const nextFeedback = [...plan.feedback, feedback];
    const replanned = await this.createPlan(
      context,
      plan.maxSteps,
      nextFeedback,
    );
    const nextState: PersistedFlowExecutionState = {
      ...state,
      plan: {
        steps: replanned.steps,
        fromModel: replanned.fromModel,
        maxSteps: plan.maxSteps,
        revision: plan.revision + 1,
        feedback: nextFeedback,
      },
      planLoop: undefined,
      pendingApproval: undefined,
    };
    return this.createPlanReviewApprovalWait(context, input, nextState);
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
    const state = readFlowExecutionState(context.task.executionState);
    const plan = requirePersistedPlan(state);
    let planLoop = state.planLoop ?? {
      stepIndex: 0,
      observations: [],
      lastStepHadToolCalls: false,
    };
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

    while (
      planLoop.stepIndex <
      Math.min(plan.steps.length, node.planLoopPolicy.maxSteps)
    ) {
      const step = plan.steps[planLoop.stepIndex];
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
        { steps: plan.steps, fromModel: plan.fromModel },
        step,
        planLoop.observations,
      );
      const stream = resumeDecision
        ? this.commonChatAgentService.resumeEvents({
            modelPreset: node.executor.modelPreset,
            messages: chatContext.messages,
            systemPrompt: stepPrompt,
            tools,
            threadId: stepExecutionId,
            approvalToolNames,
            decision: resumeDecision,
          })
        : this.commonChatAgentService.streamEvents({
            modelPreset: node.executor.modelPreset,
            messages: chatContext.messages,
            systemPrompt: stepPrompt,
            tools,
            threadId: stepExecutionId,
            approvalToolNames,
          });
      const result = await this.consumeAgentStream(context, input, stream, {
        initialContent: '',
        publishMessageDelta: false,
      });
      resumeDecision = undefined;
      if (result.approvals.length > 0) {
        const pendingState: PersistedFlowExecutionState = {
          ...state,
          planLoop,
        };
        return this.createToolApprovalWait(
          context,
          input,
          result.approvals,
          context.task.fullContent,
          pendingState,
          createApprovalTraceKey(stepExecutionId),
        );
      }

      planLoop = {
        stepIndex: planLoop.stepIndex + 1,
        observations: [...planLoop.observations, result.fullContent],
        lastStepHadToolCalls: result.hadToolCalls,
      };
      const nextState: PersistedFlowExecutionState = {
        ...state,
        planLoop,
        pendingApproval: undefined,
      };
      await this.persistPlanLoopCheckpoint(context, nextState);

      if (
        planLoop.stepIndex >=
          Math.min(plan.steps.length, node.planLoopPolicy.maxSteps) ||
        (node.planLoopPolicy.stopPolicy === 'evaluate-after-step' &&
          this.stepEvaluator.enough({
            stepsDone: planLoop.stepIndex,
            maxSteps: node.planLoopPolicy.maxSteps,
            plannedSteps: plan.steps.length,
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
          context.task.fullContent,
          nextState,
        );
      }
    }

    return this.completeNode(
      context,
      input,
      'default',
      `已完成 ${planLoop.stepIndex} 个计划步骤`,
      context.task.fullContent,
      { ...state, planLoop, pendingApproval: undefined },
    );
  }

  /**
   * 执行最终汇总节点
   * @param context 当前编译后的节点执行上下文
   * @param input Temporal 节点执行标识
   * @param resumeDecision 可选的工具审批决定
   * @returns 返回汇总回复完成或工具审批等待结果
   * @description 汇总只读取 PlanLoop 已持久化的步骤观察，不把内部步骤文本直接下发客户端；没有计划的 Flow 保持普通无工具 Agent 汇总语义。
   */
  private async executeSynthesizeNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    resumeDecision: ApprovalDecision | PlanReviewDecision | undefined,
  ): Promise<AgentFlowNodeExecutionResult> {
    const state = readFlowExecutionState(context.task.executionState);
    const agentInput = await this.createAgentLoopInput(context, []);
    const systemPrompt = buildSynthesisPrompt(
      agentInput,
      state.planLoop?.observations ?? [],
    );
    return this.executeAgentNode(
      context,
      input,
      toSynthesizeExecutor(context.agentModelPreset),
      resumeDecision as ApprovalDecision | undefined,
      systemPrompt,
    );
  }

  /**
   * 使用既有 PlannerService 创建一份任务计划
   * @param context 当前 Flow 节点执行上下文
   * @param maxSteps 当前计划步骤预算
   * @param feedback 已累计的计划打回意见
   * @returns 返回结构化或降级后的计划
   * @description Planner 的模型调用失败会在其内部回退为单步计划；本方法只负责把冻结会话与系统提示词转换成其所需输入，确保 Flow 不进入旧策略路由。
   */
  private async createPlan(
    context: AgentFlowExecutionContext,
    maxSteps: number,
    feedback: string[],
  ): Promise<AgentPlan> {
    const input = await this.createAgentLoopInput(context, []);
    return this.planner.plan(input, maxSteps, feedback);
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
    state: PersistedFlowExecutionState,
  ): Promise<AgentFlowNodeExecutionResult> {
    const plan = requirePersistedPlan(state);
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
    const traceKey = createPlanReviewTraceKey(
      input.nodeExecutionId,
      plan.revision,
    );
    const result = await this.prisma.$transaction(async (transaction) => {
      const approval = await transaction.agentFlowApproval.create({
        data: {
          taskId: context.task.id,
          runId: context.task.streamId,
          nodeKey: context.node.key,
          kind: AgentFlowApprovalKind.PLAN_REVIEW,
          requestSummary: toInputJsonValue({
            steps: plan.steps.map((step) => ({ id: step.id, goal: step.goal })),
            revision: plan.revision,
            allowedDecisions: [
              'approve',
              'edit',
              'reject_replan',
              'reject_terminate',
            ],
          }),
        },
      });
      const nextState: PersistedFlowExecutionState = {
        ...state,
        pendingApproval: {
          nodeExecutionId: input.nodeExecutionId,
          approvalId: approval.id,
        },
      };
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
              steps: plan.steps.map((step) => ({
                id: step.id,
                goal: step.goal,
              })),
              revision: plan.revision,
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
            executionState: toFlowExecutionState(nextState),
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
    node: Omit<CompiledAgentFlowNode, 'key' | 'type' | 'next'>,
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
    const stream = resumeDecision
      ? this.commonChatAgentService.resumeEvents({
          modelPreset: node.modelPreset,
          messages: chatContext.messages,
          systemPrompt,
          tools: capabilities.tools,
          threadId: input.nodeExecutionId,
          approvalToolNames: capabilities.approvalToolNames,
          decision: resumeDecision,
        })
      : this.commonChatAgentService.streamEvents({
          modelPreset: node.modelPreset,
          messages: chatContext.messages,
          systemPrompt,
          tools: capabilities.tools,
          threadId: input.nodeExecutionId,
          approvalToolNames: capabilities.approvalToolNames,
        });
    const result = await this.consumeAgentStream(context, input, stream, {
      initialContent: context.task.fullContent,
      publishMessageDelta: true,
    });
    if (result.approvals.length > 0) {
      return this.createToolApprovalWait(
        context,
        input,
        result.approvals,
        result.fullContent,
      );
    }
    return this.completeNode(
      context,
      input,
      'default',
      result.fullContent ? '已生成回复' : '节点执行完成',
      result.fullContent,
    );
  }

  /**
   * 消费底层 Agent 的结构化事件流
   * @param context 当前节点执行上下文
   * @param input Temporal 节点执行标识
   * @param stream CommonChatAgentService 的事件流
   * @returns 返回累计正文和同一轮待审批工具请求批次
   * @description token 增量只写 Redis Frame；工具生命周期仍由 Flow 节点统一投影。LangGraph 同一轮 interrupt 可能含多个工具请求，必须完整消费并作为一个审批批次持久化，随后由 Temporal Workflow 等待同一个 approvalId。
   */
  private async consumeAgentStream(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    stream: AsyncGenerator<CommonChatAgentStreamEvent, void, unknown>,
    options: { initialContent: string; publishMessageDelta: boolean },
  ): Promise<{
    fullContent: string;
    hadToolCalls: boolean;
    approvals: ApprovalRequiredPayload[];
  }> {
    let fullContent = options.initialContent;
    let hadToolCalls = false;
    const approvals: ApprovalRequiredPayload[] = [];
    for await (const event of stream) {
      if (event.type === StreamTaskEventType.MessageDelta) {
        fullContent += event.delta;
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
        event.type === StreamTaskEventType.ToolCallStart ||
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
    return { fullContent, hadToolCalls, approvals };
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
    state = readFlowExecutionState(context.task.executionState),
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
      const nextState: PersistedFlowExecutionState = {
        ...state,
        pendingApproval: {
          nodeExecutionId: input.nodeExecutionId,
          approvalId: approval.id,
        },
      };
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
            executionState: toFlowExecutionState(nextState),
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
   * @description 完成结果写入 executionState 后，Activity retry 会返回同一 outcome 而不会重新调用模型或工具。
   */
  private async completeNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    outcome: AgentFlowNodeCompletedResult['outcome'],
    summary: string,
    fullContent = context.task.fullContent,
    state = readFlowExecutionState(context.task.executionState),
  ): Promise<AgentFlowNodeCompletedResult> {
    const nextState: PersistedFlowExecutionState = {
      ...state,
      completedNodes: {
        ...state.completedNodes,
        [input.nodeExecutionId]: { outcome, summary },
      },
      pendingApproval: undefined,
    };
    const event = await this.prisma.$transaction((transaction) =>
      this.taskEventService.persistInTransaction(transaction, {
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
          fullContent,
          pausedAt: null,
          executionState: toFlowExecutionState(nextState),
        },
      }),
    );
    await this.taskEventService.publishAfterCommit(event);
    return { kind: 'completed', outcome, summary };
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
    state: PersistedFlowExecutionState,
  ): Promise<void> {
    await this.prisma.streamTask.update({
      where: { id: context.task.id },
      data: {
        currentStep: context.node.key,
        lastHeartbeatAt: new Date(),
        executionState: toFlowExecutionState(state),
      },
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
   * @returns 返回要求 Workflow 直接收尾的结果
   * @description 用户主动终止计划属于已处理的业务结果，不应伪装成错误；状态写入 executionState 后，Activity retry 返回同一 stopped 结果而不会重复发送终止事件。
   */
  private async stopNode(
    context: AgentFlowExecutionContext,
    input: AgentFlowNodeExecutionInput,
    status: 'completed' | 'cancelled' | 'error',
    summary: string,
    fullContent: string,
  ): Promise<AgentFlowNodeExecutionResult> {
    const state = readFlowExecutionState(context.task.executionState);
    const nextState: PersistedFlowExecutionState = {
      ...state,
      stoppedNodes: {
        ...state.stoppedNodes,
        [input.nodeExecutionId]: { status },
      },
      pendingApproval: undefined,
    };
    const event = await this.prisma.$transaction((transaction) =>
      this.taskEventService.persistInTransaction(transaction, {
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
          fullContent,
          pausedAt: null,
          executionState: toFlowExecutionState(nextState),
        },
      }),
    );
    await this.taskEventService.publishAfterCommit(event);
    return { kind: 'stopped', status };
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

  const nextByNodeKey = new Map<string, Record<string, string>>();
  for (const edge of definition.edges) {
    const branches = nextByNodeKey.get(edge.from) ?? {};
    branches[edge.when ?? 'default'] = edge.to;
    nextByNodeKey.set(edge.from, branches);
  }

  return {
    entryNodeKey: entryNode.id,
    maxDurationSeconds: definition.policy.maxDurationSeconds,
    nodes: definition.nodes.map((node) => ({
      key: node.id,
      type: node.type,
      next: nextByNodeKey.get(node.id) ?? {},
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
  node: Omit<CompiledAgentFlowNode, 'key' | 'type' | 'next'>,
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
): Omit<CompiledAgentFlowNode, 'key' | 'type' | 'next'> {
  return {
    modelPreset,
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
 * 读取 Flow 在 StreamTask.executionState 中的最小运行状态
 * @param value StreamTask 的 JSON 执行状态
 * @returns 返回可安全重放的开始、完成和等待审批信息
 * @description 不信任历史 JSON：字段缺失或形状异常时回退为空状态，避免旧任务残留数据被解释为已完成 Flow 节点。
 */
function readFlowExecutionState(
  value: Prisma.JsonValue | null,
): PersistedFlowExecutionState {
  const root = isJsonObject(value) ? value : undefined;
  const flow =
    root && isJsonObject(root.agentFlow) ? root.agentFlow : undefined;
  const completedValue =
    flow && isJsonObject(flow.completedNodes) ? flow.completedNodes : undefined;
  const completedNodes: Record<string, PersistedCompletedNode> = {};
  if (completedValue) {
    for (const [executionId, item] of Object.entries(completedValue)) {
      if (!isJsonObject(item)) {
        continue;
      }
      const outcome = item.outcome;
      const summary = item.summary;
      if (
        (outcome === 'default' ||
          outcome === 'approved' ||
          outcome === 'true' ||
          outcome === 'false') &&
        typeof summary === 'string'
      ) {
        completedNodes[executionId] = { outcome, summary };
      }
    }
  }
  const stoppedValue =
    flow && isJsonObject(flow.stoppedNodes) ? flow.stoppedNodes : undefined;
  const stoppedNodes: PersistedFlowExecutionState['stoppedNodes'] = {};
  if (stoppedValue) {
    for (const [executionId, item] of Object.entries(stoppedValue)) {
      if (!isJsonObject(item)) {
        continue;
      }
      const status = item.status;
      const errorCategory = item.errorCategory;
      if (
        (status === 'completed' ||
          status === 'cancelled' ||
          status === 'error') &&
        (typeof errorCategory === 'string' || errorCategory === undefined)
      ) {
        stoppedNodes[executionId] = {
          status,
          ...(typeof errorCategory === 'string' ? { errorCategory } : {}),
        };
      }
    }
  }
  const plan =
    flow && isJsonObject(flow.plan) ? readPersistedPlan(flow.plan) : undefined;
  const planLoop =
    flow && isJsonObject(flow.planLoop)
      ? readPersistedPlanLoop(flow.planLoop)
      : undefined;
  const pending =
    flow && isJsonObject(flow.pendingApproval)
      ? flow.pendingApproval
      : undefined;
  return {
    started: flow?.started === true,
    completedNodes,
    stoppedNodes,
    ...(plan ? { plan } : {}),
    ...(planLoop ? { planLoop } : {}),
    ...(typeof pending?.nodeExecutionId === 'string' &&
    typeof pending.approvalId === 'string'
      ? {
          pendingApproval: {
            nodeExecutionId: pending.nodeExecutionId,
            approvalId: pending.approvalId,
          },
        }
      : {}),
  };
}

/**
 * 将最小 Flow 运行状态编码为 Prisma JSON
 * @param state 当前 Flow 状态
 * @returns 返回可写入 StreamTask.executionState 的 JSON 对象
 * @description Flow 任务独占该状态列；只保存节点幂等键和安全摘要，不保存会话、提示词、工具原始出参或审批决定正文。
 */
function toFlowExecutionState(
  state: PersistedFlowExecutionState,
): Prisma.InputJsonObject {
  return JSON.parse(
    JSON.stringify({
      agentFlow: {
        started: state.started,
        completedNodes: state.completedNodes,
        stoppedNodes: state.stoppedNodes,
        ...(state.plan ? { plan: state.plan } : {}),
        ...(state.planLoop ? { planLoop: state.planLoop } : {}),
        ...(state.pendingApproval
          ? { pendingApproval: state.pendingApproval }
          : {}),
      },
    }),
  ) as Prisma.InputJsonObject;
}

/**
 * 从持久化 JSON 读取计划状态
 * @param value 已校验为对象的 agentFlow.plan 字段
 * @returns 返回合法计划；形状不完整时返回 undefined
 * @description 只接受服务器自己写入的步骤、修订和反馈闭集，避免手工修改 executionState 后让 Flow 解释任意对象为可执行计划。
 */
function readPersistedPlan(
  value: Prisma.JsonObject,
): PersistedFlowPlan | undefined {
  const revision = value.revision;
  if (
    !Array.isArray(value.steps) ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision)
  ) {
    return undefined;
  }
  const steps: PlanStep[] = [];
  for (const item of value.steps) {
    if (
      !isJsonObject(item) ||
      typeof item.id !== 'string' ||
      typeof item.goal !== 'string'
    ) {
      return undefined;
    }
    const suggestedTools = Array.isArray(item.suggestedTools)
      ? item.suggestedTools.filter(
          (toolName): toolName is string => typeof toolName === 'string',
        )
      : undefined;
    steps.push({
      id: item.id,
      goal: item.goal,
      ...(suggestedTools && suggestedTools.length > 0
        ? { suggestedTools }
        : {}),
    });
  }
  const feedback = Array.isArray(value.feedback)
    ? value.feedback.filter((item): item is string => typeof item === 'string')
    : [];
  const storedMaxSteps = value.maxSteps;
  const maxSteps =
    typeof storedMaxSteps === 'number' &&
    Number.isInteger(storedMaxSteps) &&
    storedMaxSteps > 0
      ? storedMaxSteps
      : Math.max(1, steps.length);
  return {
    steps,
    fromModel: value.fromModel === true,
    maxSteps,
    revision,
    feedback,
  };
}

/**
 * 从持久化 JSON 读取 PlanLoop 状态
 * @param value 已校验为对象的 agentFlow.planLoop 字段
 * @returns 返回合法步骤进度；形状不完整时返回 undefined
 * @description 观察只保存各步骤最终文本，不保存工具原始结果；读取时再次限定索引和文本数组，避免损坏快照导致越界续跑。
 */
function readPersistedPlanLoop(
  value: Prisma.JsonObject,
): PersistedFlowPlanLoop | undefined {
  const stepIndex = value.stepIndex;
  if (
    typeof stepIndex !== 'number' ||
    !Number.isInteger(stepIndex) ||
    stepIndex < 0
  ) {
    return undefined;
  }
  if (!Array.isArray(value.observations)) {
    return undefined;
  }
  const observations = value.observations.filter(
    (item): item is string => typeof item === 'string',
  );
  if (observations.length !== value.observations.length) {
    return undefined;
  }
  return {
    stepIndex,
    observations,
    lastStepHadToolCalls: value.lastStepHadToolCalls === true,
  };
}

/**
 * 读取一个 Flow 计划节点必需的计划状态
 * @param state 当前 Flow 执行状态
 * @returns 返回可执行的已持久化计划
 * @description approval 与 plan-loop 必须消费同一个 plan 节点的快照；缺少计划说明 Flow 定义或执行顺序已损坏，不能静默创建新计划。
 */
function requirePersistedPlan(
  state: PersistedFlowExecutionState,
): PersistedFlowPlan {
  if (!state.plan) {
    throw createNonRetryableActivityFailure(
      '计划节点尚未生成可执行计划',
      'AGENT_FLOW_PLAN_STATE_MISSING',
    );
  }
  return state.plan;
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
 * 计算条件节点的分支结果
 * @param condition Flow 中已校验的条件配置
 * @param state 当前 Flow 运行状态
 * @returns 条件命中时返回 true
 * @description V1 条件只读取 Flow 运行状态中的固定字段；未声明输出的字段视为不存在，不解析表达式、不执行动态代码。
 */
function evaluateCondition(
  condition: Extract<CompiledFlowNode, { type: 'condition' }>['condition'],
  state: PersistedFlowExecutionState,
): boolean {
  const value =
    condition.field === 'started'
      ? state.started
      : condition.field === 'hasPendingApproval'
        ? Boolean(state.pendingApproval)
        : undefined;
  if (condition.operator === 'exists') {
    return value !== undefined && value !== null;
  }
  if (condition.operator === 'equals') {
    return value === condition.value;
  }
  return value !== condition.value;
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
 * 将普通值转换为 Prisma JSON 输入
 * @param value 已由服务端构造的安全对象
 * @returns 返回独立的 Prisma JSON 值
 * @description JSON 往返移除 undefined，确保审批请求摘要不会因运行时对象或可选字段破坏数据库写入。
 */
function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * 获取 Flow 节点的公共展示标题
 * @param type 当前节点类型
 * @returns 返回面向 trace 和 SSE 的中文标题
 * @description 标题只反映节点类型，不包含 Flow 配置、提示词或工具原始参数。
 */
function getNodeTitle(type: FlowNodeType): string {
  switch (type) {
    case 'agent':
      return '执行智能体节点';
    case 'plan':
      return '生成执行计划';
    case 'plan-loop':
      return '执行计划步骤';
    case 'approval':
      return '等待计划确认';
    case 'condition':
      return '判断流程分支';
    case 'synthesize':
      return '汇总最终回复';
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
