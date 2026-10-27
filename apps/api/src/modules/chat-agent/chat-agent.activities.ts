import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AgentFlowApprovalKind,
  AgentFlowApprovalStatus,
  AgentFlowNodeExecutionResultKind,
  StreamTaskRuntime,
  StreamTaskStatus,
} from '@prisma/client';
import { ApplicationFailure } from '@temporalio/client';
import {
  StreamTaskEventType,
  type ApprovalDecision,
} from '@litter-bear/types/protocol';
import type { ReasoningSelection } from '@litter-bear/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentFlowTaskEventService } from '../agent-flow/agent-flow-task-event.service';
import {
  AgentRunSupport,
  FLOW_APPROVAL_TIMEOUT_SECONDS,
  STOPPED_RESULT_KIND,
  STOPPED_RESULT_STATUS,
  createNonRetryableActivityFailure,
  readJsonString,
  toAgentFlowModelFailure,
  toApprovalDecision,
  toInputJsonValue,
  toTaskErrorCategory,
  type AgentRunInput,
  type AgentRunScope,
  type FlowBudgetDimension,
  type FlowBudgetTracker,
} from '../agent-flow/runtime/agent-run.support';
import {
  FlowContextService,
  type FlowNodeContextSnapshot,
} from '../agent-flow/runtime/flow-context.service';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import { parsePersistedReasoningConfig } from '../llm/dto/reasoning-selection.dto';
import type { ModelContextEnvelope } from '../llm/model-context.schema';
import type {
  ChatAgentActivityApi,
  ChatAgentFinalizeInput,
  ChatAgentResumeInput,
  ChatAgentRunResult,
  ChatAgentWorkflowInput,
} from '../../temporal/workflows/chat-agent.workflow.types';
import {
  DEFAULT_CHAT_AGENT_LIMITS,
  DEFAULT_CHAT_AGENT_NODE_KEY,
  DEFAULT_CHAT_AGENT_TITLE,
  createChatAgentExecutionId,
} from './default-chat-agent.constants';
import { DefaultChatAgent } from './default-chat.agent';

/** 默认智能体运行所需的任务快照。 */
interface ChatAgentContext extends AgentRunScope {
  task: AgentRunScope['task'] & {
    status: StreamTaskStatus;
    agentId: string;
    fullContent: string;
    modelPreset: string;
    reasoning?: ReasoningSelection;
    toolGroups: string[];
    toolsDegraded: boolean;
  };
  agentSystemPrompt: string | null;
}

/** 图片输入为回答预留的 token 估算。 */
const VISION_RESERVED_TOKENS = 4096;

/** 模型未通过工具探测时附在节点摘要里的说明。 */
const TOOLS_DEGRADED_NOTE = '（当前模型未通过工具探测，本轮未启用工具）';

/**
 * 默认 ReAct 智能体的 Temporal Activity 实现
 * @description 负责把 DefaultChatAgent 的一次运行变成可恢复的持久化执行：冻结上下文、推送正文与工具轨迹、
 * 创建审批等待、累计预算，并以 AgentFlowNodeExecution 记录终局事实，使 Activity 重试与审批恢复都不会重复
 * 调用模型或工具。节点键固定为 `chat`，事件形状与 AgentFlow 的 agent 节点一致，端侧无需区分运行时。
 */
@Injectable()
export class ChatAgentActivities implements ChatAgentActivityApi {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: DefaultChatAgent,
    private readonly flowContextService: FlowContextService,
    private readonly runSupport: AgentRunSupport,
    private readonly taskEventService: AgentFlowTaskEventService,
    private readonly modelRegistry: LlmModelRegistryService,
  ) {}

  /**
   * 返回可注册给 Temporal Activity Worker 的绑定方法集合
   * @returns 返回本运行时全部 Activity 的稳定函数映射
   */
  getActivityHandlers(): ChatAgentActivityApi {
    return {
      runChatAgent: (input) => this.runChatAgent(input),
      resumeChatAgent: (input) => this.resumeChatAgent(input),
      finalizeChatAgentRun: (input) => this.finalizeChatAgentRun(input),
    };
  }

  /**
   * 首次运行默认智能体
   * @param input Workflow 标识
   * @returns 返回完成、等待审批或停止结果
   * @description 已有终局记录或待审批事实时直接回放，不重复执行。
   */
  async runChatAgent(input: {
    workflow: ChatAgentWorkflowInput;
  }): Promise<ChatAgentRunResult> {
    const context = await this.loadContext(input.workflow.streamTaskId);
    const run = {
      nodeExecutionId: createChatAgentExecutionId(context.task.id),
    };
    const settled = await this.replaySettled(context, run);
    if (settled) {
      return settled;
    }
    await this.emitStarted(context, run);
    return this.execute(context, run, undefined);
  }

  /**
   * 用已持久化的审批决定恢复默认智能体
   * @param input Workflow 标识与已完成审批 ID
   * @returns 返回完成、再次等待审批或停止结果
   * @description Signal 只带 approvalId；决定正文从 AgentFlowApproval 读取，且必须属于本任务的 chat 节点。
   */
  async resumeChatAgent(
    input: ChatAgentResumeInput,
  ): Promise<ChatAgentRunResult> {
    const context = await this.loadContext(input.workflow.streamTaskId);
    const run = {
      nodeExecutionId: createChatAgentExecutionId(context.task.id),
    };
    // 恢复同样先回放：上一次恢复已提交、但结果上报丢失时 Temporal 会重试，不能带着同一份决定再跑一遍
    const settled = await this.replaySettled(context, run);
    if (settled) {
      return settled;
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
      approval.nodeKey !== DEFAULT_CHAT_AGENT_NODE_KEY ||
      approval.status !== AgentFlowApprovalStatus.RESOLVED
    ) {
      throw createNonRetryableActivityFailure(
        '审批决定不存在或尚未完成',
        'AGENT_FLOW_APPROVAL_NOT_RESOLVED',
      );
    }
    if (approval.kind !== AgentFlowApprovalKind.TOOL) {
      throw createNonRetryableActivityFailure(
        '默认智能体只接受工具审批',
        'AGENT_FLOW_APPROVAL_KIND_MISMATCH',
      );
    }
    const decision = toApprovalDecision(approval.decision);
    if (!decision) {
      throw createNonRetryableActivityFailure(
        '审批决定格式无效',
        'AGENT_FLOW_APPROVAL_INVALID',
      );
    }
    return this.execute(context, run, decision);
  }

  /**
   * 收敛任务终态
   * @param input 终态与安全错误信息
   * @returns 无返回值
   * @description 与 AgentFlow 共用 AgentRunSupport.finalizeTask。
   */
  async finalizeChatAgentRun(input: ChatAgentFinalizeInput): Promise<void> {
    await this.runSupport.finalizeTask({
      streamTaskId: input.workflow.streamTaskId,
      status: input.status,
      lastNodeKey: DEFAULT_CHAT_AGENT_NODE_KEY,
      ...(input.errorCategory ? { errorCategory: input.errorCategory } : {}),
      ...(input.errorReason ? { errorReason: input.errorReason } : {}),
    });
  }

  /**
   * 读取任务创建时锁定的执行快照
   * @param streamTaskId 任务 ID
   * @returns 返回模型、思考、工具组与会话身份
   * @description 只读快照，不读 Agent 当前配置（人设除外）：任务启动后后台改模型或工具不影响它。
   */
  private async loadContext(streamTaskId: string): Promise<ChatAgentContext> {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: streamTaskId },
      select: {
        id: true,
        userId: true,
        status: true,
        runtime: true,
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
        resolvedAgentToolGroups: true,
        agentToolsDegraded: true,
      },
    });
    if (
      !task ||
      task.runtime !== StreamTaskRuntime.CHAT_AGENT ||
      !task.conversationId ||
      !task.messageId ||
      !task.agentId ||
      !task.resolvedAgentModelPresetId
    ) {
      throw createNonRetryableActivityFailure(
        '默认智能体任务上下文不完整或快照不一致',
        'AGENT_FLOW_TASK_SNAPSHOT_MISMATCH',
      );
    }
    let reasoning: ReasoningSelection | undefined;
    try {
      reasoning = parsePersistedReasoningConfig(
        task.resolvedAgentReasoningConfig,
      )?.selection;
    } catch {
      throw createNonRetryableActivityFailure(
        '任务锁定的思考配置已损坏',
        'AGENT_FLOW_TASK_SNAPSHOT_MISMATCH',
      );
    }
    // Admin 与 Activity Worker 可能是独立进程；在 Activity 边界刷新，模型解析读到最新的连接与能力档位
    await this.modelRegistry.invalidate();
    const agent = await this.prisma.agent.findUnique({
      where: { id: task.agentId },
      select: { systemPrompt: true },
    });
    const imageAssetId = readJsonString(task.requestPayload, 'imageAssetId');
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
        ...(imageAssetId ? { imageAssetId } : {}),
        modelPreset: task.resolvedAgentModelPresetId,
        ...(reasoning ? { reasoning } : {}),
        toolGroups: task.resolvedAgentToolGroups,
        toolsDegraded: task.agentToolsDegraded,
      },
      node: { key: DEFAULT_CHAT_AGENT_NODE_KEY },
      agentSystemPrompt: agent?.systemPrompt ?? null,
    };
  }

  /**
   * 回放已有终局事实
   * @param context 任务快照
   * @param run 执行标识
   * @returns 任务已终态、已有执行记录或仍在等审批时返回对应结果，否则返回 null
   * @description 幂等只依据数据库事实：任务状态、`(taskId, nodeExecutionId)` 唯一的执行记录、PENDING 审批。
   */
  private async replaySettled(
    context: ChatAgentContext,
    run: AgentRunInput,
  ): Promise<ChatAgentRunResult | null> {
    // HTTP 取消与 Workflow 取消 Signal 之间有交错窗口，先看库里的终态，避免继续调模型或工具
    if (context.task.status === StreamTaskStatus.CANCELED) {
      return { kind: 'stopped', status: 'cancelled' };
    }
    if (
      context.task.status === StreamTaskStatus.COMPLETED ||
      context.task.status === StreamTaskStatus.ERROR ||
      context.task.status === StreamTaskStatus.EXPIRED
    ) {
      return {
        kind: 'stopped',
        status:
          context.task.status === StreamTaskStatus.COMPLETED
            ? 'completed'
            : 'error',
      };
    }
    const execution = await this.prisma.agentFlowNodeExecution.findUnique({
      where: {
        taskId_nodeExecutionId: {
          taskId: context.task.id,
          nodeExecutionId: run.nodeExecutionId,
        },
      },
      select: { result: true, errorCategory: true },
    });
    if (execution) {
      if (execution.result === AgentFlowNodeExecutionResultKind.COMPLETED) {
        return { kind: 'completed' };
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
    const pending = await this.prisma.agentFlowApproval.findFirst({
      where: {
        taskId: context.task.id,
        nodeKey: DEFAULT_CHAT_AGENT_NODE_KEY,
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
   * 写入默认智能体的节点开始事件
   * @param context 任务快照
   * @param run 执行标识
   * @returns 无返回值
   * @description 由 `flowRunStartedAt IS NULL` 的条件更新声明「首次」，Activity 重试不会再发一条开始事件。
   */
  private async emitStarted(
    context: ChatAgentContext,
    run: AgentRunInput,
  ): Promise<void> {
    const event = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.streamTask.updateMany({
        where: { id: context.task.id, flowRunStartedAt: null },
        data: { flowRunStartedAt: new Date() },
      });
      if (claimed.count !== 1) {
        return null;
      }
      return this.taskEventService.persistInTransaction(transaction, {
        taskId: context.task.id,
        streamId: context.task.streamId,
        userId: context.task.userId,
        conversationId: context.task.conversationId,
        messageId: context.task.messageId,
        eventName: StreamTaskEventType.FlowNodeStarted,
        status: StreamTaskStatus.STREAMING,
        payload: {
          nodeKey: DEFAULT_CHAT_AGENT_NODE_KEY,
          nodeType: 'agent',
          title: DEFAULT_CHAT_AGENT_TITLE,
          traceKey: createChatTraceKey(run.nodeExecutionId),
        },
        taskUpdate: {
          startedAt: new Date(),
          currentStep: DEFAULT_CHAT_AGENT_NODE_KEY,
        },
      });
    });
    if (event) {
      await this.taskEventService.publishAfterCommit(event);
    }
  }

  /**
   * 运行或恢复一次 ReAct 循环并落库结果
   * @param context 任务快照
   * @param run 执行标识
   * @param decision 恢复时的工具审批决定；首轮缺省
   * @returns 返回完成、等待审批或预算停止结果
   * @description 上下文快照按执行标识冻结，恢复时读到与首轮完全相同的消息；模型与工具调用逐次计入预算，
   * 流中突破即停。完成记录与完成事件同事务提交，事件已发而记录缺失会让重试重复执行。
   */
  private async execute(
    context: ChatAgentContext,
    run: AgentRunInput,
    decision: ApprovalDecision | undefined,
  ): Promise<ChatAgentRunResult> {
    const assembly = await this.agent.assemble({
      userId: context.task.userId,
      agentSystemPrompt: context.agentSystemPrompt,
      toolGroups: context.task.toolGroups,
    });
    const budget = this.runSupport.createTaskBudgetTracker(
      context,
      DEFAULT_CHAT_AGENT_LIMITS,
    );
    if (budget.modelCallExhausted()) {
      return this.stopOnBudgetExceeded(context, run, 'maxModelCalls');
    }
    const snapshot = await this.prepareContext(context, run, assembly, budget);
    if (budget.modelCallExhausted()) {
      return this.stopOnBudgetExceeded(context, run, 'maxModelCalls');
    }
    const vision = context.task.imageAssetId
      ? await this.runSupport.prepareAnswerVision(
          context,
          context.task.modelPreset,
          snapshot.messages,
        )
      : undefined;
    let modelContext: ModelContextEnvelope | undefined;
    const stream = this.agent.run({
      modelPreset: context.task.modelPreset,
      reasoning: context.task.reasoning,
      assembly,
      messages: vision?.messages ?? snapshot.messages,
      systemPrompt: snapshot.systemPrompt,
      inputTokenLimit: snapshot.inputTokenLimit,
      maxOutputTokens: snapshot.maxOutputTokens,
      threadId: run.nodeExecutionId,
      onModelTurn: budget.countModelCall,
      onSummaryModelCall: this.runSupport.countSummaryModelCall(
        budget,
        '工具上下文压缩已达到模型调用预算',
      ),
      onCompletedModelContext: (value) => {
        modelContext = value;
      },
      ...(vision?.transform ? { visionTransform: vision.transform } : {}),
      ...(decision ? { decision } : {}),
    });

    let result: Awaited<ReturnType<AgentRunSupport['consumeAgentStream']>>;
    try {
      result = await this.runSupport.runTrackedModelNode(
        context,
        run,
        context.task.modelPreset,
        context.task.reasoning,
        snapshot.estimatedInputTokens,
        () =>
          this.runSupport.consumeAgentStream(context, run, stream, {
            initialContent: context.task.fullContent,
            publishMessageDelta: true,
            budget,
          }),
        snapshot,
      );
    } catch (error) {
      throw toAgentFlowModelFailure(error);
    }
    await budget.flush();
    if (result.overspent) {
      return this.stopOnBudgetExceeded(
        context,
        run,
        result.overspent,
        result.fullContent,
      );
    }
    if (result.approvals.length > 0) {
      return this.runSupport.createToolApprovalWait(
        context,
        run,
        result.approvals,
        result.fullContent,
      );
    }
    await this.complete(context, run, result.fullContent, result.nodeText, {
      ...(modelContext ? { modelContext } : {}),
    });
    return { kind: 'completed' };
  }

  /**
   * 冻结本次运行的模型输入
   * @param context 任务快照
   * @param run 执行标识
   * @param assembly 已装配的工具与系统提示词
   * @param budget 预算追踪器，会话摘要调用也计入
   * @returns 返回固定消息、预算与来源清单
   * @description 读会话历史（自动摘要）+ 本轮用户消息；失败明确终止，不伪装成无历史。
   */
  private async prepareContext(
    context: ChatAgentContext,
    run: AgentRunInput,
    assembly: { systemPrompt: string; tools: readonly unknown[] },
    budget: FlowBudgetTracker,
  ): Promise<FlowNodeContextSnapshot> {
    try {
      return await this.flowContextService.prepare({
        taskId: context.task.id,
        nodeExecutionId: run.nodeExecutionId,
        phase: 'model',
        conversationId: context.task.conversationId,
        pendingMessageId: context.task.messageId,
        agentId: context.task.agentId,
        startNodeKey: DEFAULT_CHAT_AGENT_NODE_KEY,
        currentInput: context.task.inputText,
        modelPreset: context.task.modelPreset,
        systemPrompt: assembly.systemPrompt,
        policy: { conversation: 'auto' },
        tools: assembly.tools,
        extraTokens: context.task.imageAssetId ? VISION_RESERVED_TOKENS : 0,
        onSummaryModelCall: this.runSupport.countSummaryModelCall(
          budget,
          '会话压缩已达到模型调用预算上限',
        ),
      });
    } catch (error) {
      if (error instanceof ApplicationFailure) throw error;
      if (error instanceof BadRequestException)
        throw createNonRetryableActivityFailure(
          error.message,
          'AGENT_FLOW_RUNTIME_CONTEXT_INVALID',
        );
      throw createNonRetryableActivityFailure(
        '会话上下文准备失败，请重试或检查摘要模型配置',
        'AGENT_FLOW_CONTEXT_ERROR',
      );
    }
  }

  /**
   * 持久化完成结果
   * @param context 任务快照
   * @param run 执行标识
   * @param fullContent 任务累计正文
   * @param nodeText 本次运行产出的正文
   * @param options 供应商私有上下文
   * @returns 无返回值
   * @description 降级运行在摘要里写明「本轮未启用工具」，用户能在轨迹里看到为什么没有调用工具。
   */
  private async complete(
    context: ChatAgentContext,
    run: AgentRunInput,
    fullContent: string,
    nodeText: string,
    options: { modelContext?: ModelContextEnvelope },
  ): Promise<void> {
    const summary = `${fullContent ? '已生成回复' : '执行完成'}${
      context.task.toolsDegraded ? TOOLS_DEGRADED_NOTE : ''
    }`;
    const event = await this.prisma.$transaction(async (transaction) => {
      await transaction.agentFlowNodeExecution.create({
        data: {
          taskId: context.task.id,
          nodeExecutionId: run.nodeExecutionId,
          nodeKey: DEFAULT_CHAT_AGENT_NODE_KEY,
          result: AgentFlowNodeExecutionResultKind.COMPLETED,
          outcome: 'default',
          summary,
          outputs: toInputJsonValue({ text: nodeText }),
        },
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
          nodeKey: DEFAULT_CHAT_AGENT_NODE_KEY,
          nodeType: 'agent',
          traceKey: createChatTraceKey(run.nodeExecutionId),
          summary,
          durationMs: 0,
        },
        taskUpdate: {
          currentStep: DEFAULT_CHAT_AGENT_NODE_KEY,
          fullContent,
          pausedAt: null,
        },
      });
    });
    await this.taskEventService.publishAfterCommit(event);
  }

  /**
   * 因突破运行预算而停止
   * @param context 任务快照
   * @param run 执行标识
   * @param dimension 被突破的预算维度
   * @param fullContent 突破前已累计的正文，保留给用户已看到的部分
   * @returns 返回要求 Workflow 收敛为 error 的结果
   */
  private async stopOnBudgetExceeded(
    context: ChatAgentContext,
    run: AgentRunInput,
    dimension: FlowBudgetDimension,
    fullContent = context.task.fullContent,
  ): Promise<ChatAgentRunResult> {
    const summary =
      dimension === 'maxModelCalls'
        ? `已达到模型调用预算上限（${DEFAULT_CHAT_AGENT_LIMITS.maxModelCalls} 次），任务停止`
        : `已达到工具调用预算上限（${DEFAULT_CHAT_AGENT_LIMITS.maxToolCalls} 次），任务停止`;
    const event = await this.prisma.$transaction(async (transaction) => {
      await transaction.agentFlowNodeExecution.create({
        data: {
          taskId: context.task.id,
          nodeExecutionId: run.nodeExecutionId,
          nodeKey: DEFAULT_CHAT_AGENT_NODE_KEY,
          result: STOPPED_RESULT_KIND.error,
          summary,
          errorCategory: 'budget_exceeded',
        },
      });
      return this.taskEventService.persistInTransaction(transaction, {
        taskId: context.task.id,
        streamId: context.task.streamId,
        userId: context.task.userId,
        conversationId: context.task.conversationId,
        messageId: context.task.messageId,
        eventName: StreamTaskEventType.FlowNodeFailed,
        status: StreamTaskStatus.STREAMING,
        payload: {
          nodeKey: DEFAULT_CHAT_AGENT_NODE_KEY,
          title: DEFAULT_CHAT_AGENT_TITLE,
          nodeType: 'agent',
          traceKey: createChatTraceKey(run.nodeExecutionId),
          category: 'budget_exceeded',
          retryable: false,
        },
        taskUpdate: {
          currentStep: DEFAULT_CHAT_AGENT_NODE_KEY,
          fullContent,
          pausedAt: null,
        },
      });
    });
    await this.taskEventService.publishAfterCommit(event);
    return {
      kind: 'stopped',
      status: 'error',
      errorCategory: 'budget_exceeded',
    };
  }
}

/** 节点生命周期事件共用的 traceKey，与 AgentFlow 节点同一形状。 */
function createChatTraceKey(nodeExecutionId: string): string {
  return `flow:node:${nodeExecutionId}`;
}
