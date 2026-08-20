import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
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
  const finalizeActivities = createFinalizeActivities(input.activityTaskQueue);
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
    // 必须走 nonCancellable：原生取消（Temporal UI 的 Cancel、handle.cancel()）会取消
    // 当前 scope 内所有 Activity 与 Timer，普通调度的终态写入会立刻以 CancelledFailure
    // 失败，StreamTask 永久停在 RUNNING、SSE 流不关闭，前端只能一直转圈。
    await CancellationScope.nonCancellable(() =>
      finalizeActivities.finalizeRun({
        workflow: input,
        status,
        lastNodeKey,
        ...(errorCategory ? { errorCategory } : {}),
      }),
    );
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

      // 已观测到的步骤进度，用于拒绝不推进的空转调度；人工恢复后重置
      let observedSteps = -1;
      while (result.kind === 'waiting_human' || result.kind === 'continued') {
        // 逐步调度使得时长预算与取消信号在每个步骤之间都能生效，
        // 而不是只在节点边界——单个 plan-loop 节点可能持续数分钟。
        if (cancelled) {
          return finalize('cancelled');
        }
        if (Date.now() >= deadlineMs) {
          return finalize('timed_out');
        }

        if (result.kind === 'continued') {
          if (result.completedSteps <= observedSteps) {
            throw ApplicationFailure.nonRetryable(
              `节点「${node.key}」连续调度未推进步骤，拒绝空转`,
              'AGENT_FLOW_NON_RETRYABLE',
            );
          }
          observedSteps = result.completedSteps;
          result = await activities.continueNode({
            workflow: input,
            nodeKey: node.key,
            nodeExecutionId,
          });
          continue;
        }

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
        // 恢复会补完被中断的那一步，进度基线随之失效
        observedSteps = -1;
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
      // 原生取消不是失败：Activity 与 condition 都会抛 CancelledFailure，若按错误收敛
      // 会把运维的一次 Cancel 记成 WORKFLOW_ACTIVITY_FAILED，误导排障。
      if (isCancellation(error)) {
        await finalize('cancelled');
      } else {
        await finalize('error', 'WORKFLOW_ACTIVITY_FAILED');
      }
    }
    // 继续抛出以让 Temporal 把执行收敛为 CANCELLED / FAILED，而不是伪装成正常完成
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
 * 创建终态写入专用的 Activity 代理
 * @param activityTaskQueue 由启动输入冻结的业务 Activity 队列名
 * @returns 返回只含 finalizeRun 的 Activity 集合
 * @description 终态写入是唯一让 StreamTask 离开 RUNNING、让 SSE 流关闭的动作，失败代价
 * 远高于普通节点调度，因此比业务 Activity 给更多重试与更长退避上限；节点调度仍用
 * createActivities 的三次重试，避免真实故障时长时间挂住整条 Flow。
 */
function createFinalizeActivities(
  activityTaskQueue: string,
): Pick<AgentFlowActivityApi, 'finalizeRun'> {
  return proxyActivities<Pick<AgentFlowActivityApi, 'finalizeRun'>>({
    taskQueue: activityTaskQueue,
    startToCloseTimeout: '5 minutes',
    retry: {
      initialInterval: '1 second',
      maximumInterval: '30 seconds',
      maximumAttempts: 10,
      nonRetryableErrorTypes: ['AGENT_FLOW_INVALID_SNAPSHOT'],
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
