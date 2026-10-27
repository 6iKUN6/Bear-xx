import {
  ApplicationFailure,
  CancellationScope,
  condition,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { TaskErrorCategory } from '@litter-bear/types/protocol';
import type { AgentFlowFinalStatus } from './agent-flow.workflow.types';
import {
  agentFlowApprovalSignal,
  agentFlowCancelSignal,
} from './agent-flow.workflow';
import {
  DEFAULT_CHAT_AGENT_LIMITS,
  type ChatAgentActivityApi,
  type ChatAgentRunResult,
  type ChatAgentWorkflowInput,
  type ChatAgentWorkflowResult,
} from './chat-agent.workflow.types';
import { describeWorkflowFailure } from './workflow-failure';

/**
 * 默认 ReAct 智能体的 agent loop
 * @param input StreamTask 标识与 Activity 队列
 * @returns 返回完成、取消、超时或错误时的最小终态
 * @description 推理与工具循环本身由 LangChain 在 Activity 内完成；Workflow 只负责它跨不过去的部分：
 * 等待人工审批（可能长达十几分钟）、整体时长上限、取消与终态收敛。审批与取消复用 AgentFlow 的
 * Signal 名，HTTP 侧的审批 outbox 与取消派发器因此不区分两种运行时。
 */
export async function chatAgentWorkflow(
  input: ChatAgentWorkflowInput,
): Promise<ChatAgentWorkflowResult> {
  if (!input.activityTaskQueue) {
    throw ApplicationFailure.nonRetryable(
      '默认智能体 Workflow 缺少 Activity 队列',
      'AGENT_FLOW_INVALID_SNAPSHOT',
    );
  }
  const activities = proxyActivities<
    Pick<ChatAgentActivityApi, 'runChatAgent' | 'resumeChatAgent'>
  >({
    taskQueue: input.activityTaskQueue,
    startToCloseTimeout: '5 minutes',
    retry: {
      initialInterval: '1 second',
      maximumInterval: '10 seconds',
      maximumAttempts: 3,
      nonRetryableErrorTypes: [
        'AGENT_FLOW_INVALID_SNAPSHOT',
        'AGENT_FLOW_NON_RETRYABLE',
      ],
    },
  });
  // 终态写入是唯一让 StreamTask 离开 RUNNING、让 SSE 流关闭的动作，重试给得比推进更宽
  const finalizeActivities = proxyActivities<
    Pick<ChatAgentActivityApi, 'finalizeChatAgentRun'>
  >({
    taskQueue: input.activityTaskQueue,
    startToCloseTimeout: '5 minutes',
    retry: {
      initialInterval: '1 second',
      maximumInterval: '30 seconds',
      maximumAttempts: 10,
      nonRetryableErrorTypes: ['AGENT_FLOW_INVALID_SNAPSHOT'],
    },
  });
  const resolvedApprovalIds = new Set<string>();
  let cancelled = false;
  let finalizationStarted = false;

  setHandler(agentFlowApprovalSignal, ({ approvalId }) => {
    if (approvalId) {
      resolvedApprovalIds.add(approvalId);
    }
  });
  setHandler(agentFlowCancelSignal, () => {
    cancelled = true;
  });

  const finalize = async (
    status: AgentFlowFinalStatus,
    errorCategory?: TaskErrorCategory,
    errorReason?: string,
  ): Promise<ChatAgentWorkflowResult> => {
    finalizationStarted = true;
    // nonCancellable：原生取消会取消当前 scope 内的 Activity，终态写不进去任务就永远停在 RUNNING
    await CancellationScope.nonCancellable(() =>
      finalizeActivities.finalizeChatAgentRun({
        workflow: input,
        status,
        ...(errorCategory ? { errorCategory } : {}),
        ...(errorReason ? { errorReason } : {}),
      }),
    );
    return { status };
  };

  try {
    const deadlineMs =
      Date.now() + DEFAULT_CHAT_AGENT_LIMITS.maxDurationSeconds * 1_000;
    if (cancelled) {
      return await finalize('cancelled');
    }
    let result: ChatAgentRunResult = await activities.runChatAgent({
      workflow: input,
    });
    while (result.kind === 'waiting_human') {
      const { approvalId, timeoutSeconds } = result;
      const signalReceived = await condition(
        () => cancelled || resolvedApprovalIds.has(approvalId),
        Math.min(timeoutSeconds * 1_000, Math.max(1, deadlineMs - Date.now())),
      );
      if (cancelled) {
        return await finalize('cancelled');
      }
      if (!signalReceived || Date.now() >= deadlineMs) {
        return await finalize('timed_out');
      }
      resolvedApprovalIds.delete(approvalId);
      result = await activities.resumeChatAgent({
        workflow: input,
        approvalId,
      });
    }
    if (result.kind === 'stopped') {
      return await finalize(result.status, result.errorCategory);
    }
    return await finalize('completed');
  } catch (error) {
    if (!finalizationStarted) {
      // 原生取消不是失败，按 cancelled 收敛，避免把运维的一次 Cancel 记成执行错误
      if (isCancellation(error)) {
        await finalize('cancelled');
      } else {
        const failure = describeWorkflowFailure(error);
        await finalize('error', failure.category, failure.reason);
      }
    }
    // 继续抛出以让 Temporal 把执行收敛为 CANCELLED / FAILED，而不是伪装成正常完成
    throw error;
  }
}
