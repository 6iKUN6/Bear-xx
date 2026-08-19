import {
  ApplicationFailure,
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  AgentFlowActivityApi,
  AgentFlowApprovalSignalInput,
  AgentFlowFinalStatus,
  AgentFlowNodeCompletedResult,
  AgentFlowRunSnapshot,
  AgentFlowWorkflowInput,
  AgentFlowWorkflowNode,
  AgentFlowWorkflowResult,
} from './agent-flow.workflow.types';

/** 只携带 approvalId 的审批完成 Signal。 */
export const agentFlowApprovalSignal = defineSignal<
  [AgentFlowApprovalSignalInput]
>('agent-flow-approval-resolved');

/** 取消 Flow 的独立 Signal，不复用审批 Signal。 */
export const agentFlowCancelSignal = defineSignal('agent-flow-cancelled');

/**
 * 执行一个已冻结版本的 AgentFlow
 * @param input StreamTask 与 FlowVersion 的最小标识快照
 * @returns 返回完成、取消、超时或错误时的最小终态
 * @description Workflow 只拥有节点推进、等待、Timer、重试和取消；数据库、LLM、MCP、Redis 与审批决定正文全部保留在 Activity 和业务库中。
 */
export async function agentFlowWorkflow(
  input: AgentFlowWorkflowInput,
): Promise<AgentFlowWorkflowResult> {
  const activities = createActivities(input.activityTaskQueue);
  const resolvedApprovalIds = new Set<string>();
  let cancelled = false;
  let lastNodeKey: string | null = null;
  let finalizationStarted = false;

  setHandler(agentFlowApprovalSignal, ({ approvalId }) => {
    if (approvalId) {
      resolvedApprovalIds.add(approvalId);
    }
  });
  setHandler(agentFlowCancelSignal, () => {
    cancelled = true;
  });

  /**
   * 通过 Activity 写入任务终态
   * @param status 待写入的受限终态
   * @param errorCategory 可展示且不含敏感正文的错误分类
   * @returns 返回 Workflow 调用方需要的最小结果
   * @description 终态持久化只发生一次；Activity 负责按 task/node identity 去重，Workflow 不直接写业务数据库。
   */
  const finalize = async (
    status: AgentFlowFinalStatus,
    errorCategory?: string,
  ): Promise<AgentFlowWorkflowResult> => {
    finalizationStarted = true;
    await activities.finalizeRun({
      workflow: input,
      status,
      lastNodeKey,
      ...(errorCategory ? { errorCategory } : {}),
    });
    return { status, lastNodeKey };
  };

  try {
    const snapshot = await activities.loadRunSnapshot(input);
    const nodesByKey = indexSnapshotNodes(snapshot);
    const deadlineMs = Date.now() + snapshot.maxDurationSeconds * 1_000;
    let nodeKey: string | undefined = snapshot.entryNodeKey;

    while (nodeKey) {
      if (cancelled) {
        return finalize('cancelled');
      }
      if (Date.now() >= deadlineMs) {
        return finalize('timed_out');
      }

      const node = getSnapshotNode(nodesByKey, nodeKey);
      lastNodeKey = node.key;
      const nodeExecutionId = createNodeExecutionId(input, node.key);
      let result = await activities.executeNode({
        workflow: input,
        nodeKey: node.key,
        nodeExecutionId,
      });

      while (result.kind === 'waiting_human') {
        const waitingResult = result;
        const remainingMs = deadlineMs - Date.now();
        const waitTimeoutMs = Math.min(
          waitingResult.timeoutSeconds * 1_000,
          Math.max(1, remainingMs),
        );
        const signalReceived = await condition(
          () => cancelled || resolvedApprovalIds.has(waitingResult.approvalId),
          waitTimeoutMs,
        );
        if (cancelled) {
          return finalize('cancelled');
        }
        if (!signalReceived || Date.now() >= deadlineMs) {
          return finalize('timed_out');
        }
        resolvedApprovalIds.delete(waitingResult.approvalId);
        result = await activities.resumeNode({
          workflow: input,
          nodeKey: node.key,
          nodeExecutionId,
          approvalId: waitingResult.approvalId,
        });
      }

      if (result.kind === 'stopped') {
        return finalize(result.status, result.errorCategory);
      }
      nodeKey = selectNextNodeKey(node, result);
    }

    return finalize('completed');
  } catch (error) {
    if (!finalizationStarted) {
      await activities.finalizeRun({
        workflow: input,
        status: 'error',
        lastNodeKey,
        errorCategory: 'WORKFLOW_ACTIVITY_FAILED',
      });
    }
    throw error;
  }
}

/**
 * 创建投递到独立 Activity 队列的 Activity 代理
 * @param activityTaskQueue 由启动输入冻结的业务 Activity 队列名
 * @returns 返回可调度节点、审批恢复与终态收敛的 Activity 集合
 * @description Workflow 自身始终运行在编排队列，业务 Activity 必须明确投递到单独队列；队列名仅为部署路由信息，不包含用户或任务敏感数据。
 */
function createActivities(activityTaskQueue: string): AgentFlowActivityApi {
  if (!activityTaskQueue) {
    throw ApplicationFailure.nonRetryable(
      'Flow Workflow 缺少 Activity 队列',
      'AGENT_FLOW_INVALID_SNAPSHOT',
    );
  }
  return proxyActivities<AgentFlowActivityApi>({
    taskQueue: activityTaskQueue,
    startToCloseTimeout: '5 minutes',
    retry: {
      initialInterval: '1 second',
      maximumInterval: '10 seconds',
      maximumAttempts: 3,
      nonRetryableErrorTypes: [
        'AGENT_FLOW_INVALID_SNAPSHOT',
        'AGENT_FLOW_NODE_EXECUTOR_UNAVAILABLE',
        'AGENT_FLOW_NON_RETRYABLE',
      ],
    },
  });
}

/**
 * 将快照节点索引为稳定键映射
 * @param snapshot 由 Activity 提供的最小执行快照
 * @returns 返回按节点键读取的不可变映射
 * @description 即使 Activity 已验证数据，Workflow 仍拒绝缺失入口或重复节点，避免因损坏 History 产生非确定性推进。
 */
function indexSnapshotNodes(
  snapshot: AgentFlowRunSnapshot,
): ReadonlyMap<string, AgentFlowWorkflowNode> {
  if (snapshot.maxDurationSeconds < 1) {
    throw ApplicationFailure.nonRetryable(
      'Flow 运行快照的最大时长非法',
      'AGENT_FLOW_INVALID_SNAPSHOT',
    );
  }
  const nodesByKey = new Map<string, AgentFlowWorkflowNode>();
  for (const node of snapshot.nodes) {
    if (!node.key || nodesByKey.has(node.key)) {
      throw ApplicationFailure.nonRetryable(
        'Flow 运行快照包含重复或空节点键',
        'AGENT_FLOW_INVALID_SNAPSHOT',
      );
    }
    nodesByKey.set(node.key, node);
  }
  if (!nodesByKey.has(snapshot.entryNodeKey)) {
    throw ApplicationFailure.nonRetryable(
      'Flow 运行快照缺少入口节点',
      'AGENT_FLOW_INVALID_SNAPSHOT',
    );
  }
  return nodesByKey;
}

/**
 * 读取当前节点的脱敏快照
 * @param nodesByKey 节点键映射
 * @param nodeKey 当前节点键
 * @returns 返回唯一的当前节点
 * @description 所有边都由冻结快照引用；不存在的目标节点属于不可重试的版本或数据损坏错误。
 */
function getSnapshotNode(
  nodesByKey: ReadonlyMap<string, AgentFlowWorkflowNode>,
  nodeKey: string,
): AgentFlowWorkflowNode {
  const node = nodesByKey.get(nodeKey);
  if (!node) {
    throw ApplicationFailure.nonRetryable(
      `Flow 运行快照缺少节点「${nodeKey}」`,
      'AGENT_FLOW_INVALID_SNAPSHOT',
    );
  }
  return node;
}

/**
 * 根据节点结果选择唯一的下一条冻结边
 * @param node 当前节点的脱敏快照
 * @param result 节点已完成时返回的受限结果
 * @returns 返回下一节点键；终点返回 undefined
 * @description 只读取 FlowVersion 固化的 next 映射，不访问草稿、数据库或运行时随机状态。
 */
function selectNextNodeKey(
  node: AgentFlowWorkflowNode,
  result: AgentFlowNodeCompletedResult,
): string | undefined {
  const nextNodeKey = node.next[result.outcome];
  if (nextNodeKey) {
    return nextNodeKey;
  }
  if (Object.keys(node.next).length === 0) {
    return undefined;
  }
  throw ApplicationFailure.nonRetryable(
    `节点「${node.key}」缺少结果「${result.outcome}」对应的边`,
    'AGENT_FLOW_INVALID_SNAPSHOT',
  );
}

/**
 * 创建节点 Activity 的稳定幂等键
 * @param input 当前 Workflow 的最小业务标识
 * @param nodeKey 当前节点键
 * @returns 返回跨 Activity retry 与 Workflow replay 不变的执行标识
 * @description V1 Flow 不允许图级循环，同一冻结版本中的节点最多推进一次，因此 task、version 与 nodeKey 足以标识一次节点业务执行。
 */
function createNodeExecutionId(
  input: AgentFlowWorkflowInput,
  nodeKey: string,
): string {
  return `${input.streamTaskId}:${input.flowVersionId}:${nodeKey}`;
}
