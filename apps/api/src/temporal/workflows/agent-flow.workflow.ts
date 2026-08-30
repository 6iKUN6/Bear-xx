import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { TaskErrorCategory } from '@litter-bear/types/protocol';
import type {
  AgentFlowActivityApi,
  AgentFlowApprovalSignalInput,
  AgentFlowFinalStatus,
  AgentFlowNodeCompletedResult,
  AgentFlowNodeExecutionResult,
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
    errorCategory?: TaskErrorCategory,
    errorReason?: string,
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
        ...(errorReason ? { errorReason } : {}),
      }),
    );
    return { status, lastNodeKey };
  };

  try {
    const snapshot = await activities.loadRunSnapshot(input);
    const nodesByKey = indexSnapshotNodes(snapshot);
    const deadlineMs = Date.now() + snapshot.maxDurationSeconds * 1_000;

    /**
     * 把一个节点推进到终局结果
     * @param nodeKey 待推进节点键
     * @returns 返回 completed 或 stopped；中途取消或超时抛出哨兵以让整条 Flow 收敛
     * @description 原来的 waiting_human / continued 循环整段移到这里，于是每个并行分支各自
     * 独立地等审批、逐步推进 plan-loop，互不阻塞。
     */
    const advanceNode = async (
      nodeKey: string,
    ): Promise<{ node: AgentFlowWorkflowNode; result: SettledNodeResult }> => {
      const node = getSnapshotNode(nodesByKey, nodeKey);
      lastNodeKey = node.key;
      // 轮次恒为 0：识别循环体并在 `again` 分支时递增属于 issue #9 的第 4 步。这一步只把
      // 轮次穿进幂等键的形状，避免那一步再改一次键。
      const nodeExecutionId = createNodeExecutionId(input, node.key, 0);
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
        assertRunnable();

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
          throw new RunHaltedError('cancelled');
        }
        if (!signalReceived || Date.now() >= deadlineMs) {
          throw new RunHaltedError('timed_out');
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
      return { node, result };
    };

    /**
     * 检查是否还允许继续推进
     * @returns 无返回值
     * @description 取消与超时用抛哨兵而不是 return：它在并行分支内部触发，只有抛出才能让
     * 整条 Flow 收敛，return 只会结束当前分支、其余分支继续跑下去。
     */
    function assertRunnable(): void {
      if (cancelled) {
        throw new RunHaltedError('cancelled');
      }
      if (Date.now() >= deadlineMs) {
        throw new RunHaltedError('timed_out');
      }
    }

    /** 已完成的节点，用于 join 的汇聚判定 */
    const completed = new Set<string>();
    /** 已调度过的节点，防止同一节点被两条分支各调度一次 */
    const scheduled = new Set<string>();
    /** 正在推进中的节点；键排序后参与 race，保证重放时的调度顺序一致 */
    const inFlight = new Map<
      string,
      Promise<{
        key: string;
        node: AgentFlowWorkflowNode;
        result: SettledNodeResult;
      }>
    >();

    const launch = (nodeKey: string): void => {
      scheduled.add(nodeKey);
      inFlight.set(
        nodeKey,
        advanceNode(nodeKey).then((settled) => ({ key: nodeKey, ...settled })),
      );
    };
    // 入口节点也要先过一遍准入：取消信号可能在 loadRunSnapshot 的 await 期间就到了，
    // 此时一个节点都不该执行。原来的单游标实现是在循环顶部检查，改成前沿后这里要显式补上。
    assertRunnable();
    launch(snapshot.entryNodeKey);

    // 持续在飞而不是「一轮一屏障」：用 Promise.all 逐轮收口时，join(any) 仍要等当轮
    // 全部节点结束才推进后继，等于把 any 退化成 all——配置说「任一完成即继续」就必须
    // 真的这样跑。这里每有一个节点落地就重算一次前沿。
    while (inFlight.size > 0) {
      assertRunnable();

      const settled = await Promise.race(
        [...inFlight.keys()].sort().map((key) => inFlight.get(key)!),
      );
      inFlight.delete(settled.key);

      if (settled.result.kind === 'stopped') {
        // 不掀桌：其余分支的副作用已经发生，中途放弃会让事件序与预算账目对不上。
        // 等它们各自落地后再收敛终态，且不再扩展前沿。
        const stopped = settled.result;
        while (inFlight.size > 0) {
          const remaining = await Promise.race(
            [...inFlight.keys()].sort().map((key) => inFlight.get(key)!),
          );
          inFlight.delete(remaining.key);
        }
        return finalize(stopped.status, stopped.errorCategory);
      }

      completed.add(settled.key);

      // 排序让新增节点的启动顺序只由节点键决定，不受 Set 插入顺序影响
      const candidates = [
        ...new Set(selectNextNodeKeys(settled.node, settled.result)),
      ].sort();
      for (const target of candidates) {
        if (scheduled.has(target)) {
          continue;
        }
        if (!isJoinSatisfied(getSnapshotNode(nodesByKey, target), completed)) {
          // 还没等齐；等其余分支落地后的某一次循环再进入
          continue;
        }
        launch(target);
      }
    }

    return finalize('completed');
  } catch (error) {
    if (!finalizationStarted) {
      // 并行分支内部抛出的取消/超时哨兵：它不是失败，按对应终态收敛
      if (error instanceof RunHaltedError) {
        return finalize(error.status);
      }
      // 原生取消不是失败：Activity 与 condition 都会抛 CancelledFailure，若按错误收敛
      // 会把运维的一次 Cancel 记成 WORKFLOW_ACTIVITY_FAILED，误导排障。
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
function selectNextNodeKeys(
  node: AgentFlowWorkflowNode,
  result: AgentFlowNodeCompletedResult,
): readonly string[] {
  const targets = node.next[result.outcome];
  if (targets && targets.length > 0) {
    return targets;
  }
  if (Object.keys(node.next).length === 0) {
    return [];
  }
  throw ApplicationFailure.nonRetryable(
    `节点「${node.key}」缺少结果「${result.outcome}」对应的边`,
    'AGENT_FLOW_INVALID_SNAPSHOT',
  );
}

/**
 * 判断一个 join 节点是否已满足汇聚条件
 * @param node 目标节点；非 join 一律视为满足
 * @param completed 已完成的节点集合
 * @returns 可以进入前沿时返回 true
 * @description all 要等齐全部 waitFor，any 只要有一个到位。
 * `any` 语义下**不取消**未完成的分支：取消会打乱预算计数与事件序，而让它们跑完只多花一点额度。
 * 它们的结果不进入下游——下游能引用的只有「必定已完成」分析给出保证的那部分。
 */
function isJoinSatisfied(
  node: AgentFlowWorkflowNode,
  completed: ReadonlySet<string>,
): boolean {
  if (!node.join) {
    return true;
  }
  return node.join.policy === 'all'
    ? node.join.waitFor.every((key) => completed.has(key))
    : node.join.waitFor.some((key) => completed.has(key));
}

/**
 * 取消或超时的哨兵
 * @description 并行分支内部无法用 return 让整条 Flow 收敛——那只会结束当前分支。
 * 抛出后由外层统一翻译成终态。刻意不继承 ApplicationFailure：它不该进入
 * FAILURE_TYPE_CATEGORY 的白名单，也不该被当作执行失败重试。
 */
class RunHaltedError extends Error {
  constructor(
    readonly status: Extract<AgentFlowFinalStatus, 'cancelled' | 'timed_out'>,
  ) {
    super(`flow halted: ${status}`);
    this.name = 'RunHaltedError';
  }
}

/** 节点推进到终局后只可能是这两种。 */
type SettledNodeResult = Extract<
  AgentFlowNodeExecutionResult,
  { kind: 'completed' } | { kind: 'stopped' }
>;

/**
 * 创建节点 Activity 的稳定幂等键
 * @param input 当前 Workflow 的最小业务标识
 * @param nodeKey 当前节点键
 * @returns 返回跨 Activity retry 与 Workflow replay 不变的执行标识
 * @description 循环下同一个 nodeKey 会跑多轮，因此标识里必须带轮次——否则第二轮写入撞
 * `(taskId, nodeExecutionId)` 唯一键，而 `replayFinishedNode` 更会直接回放第一轮的结果、
 * 让循环静默退化成只跑一轮。
 *
 * 轮次由 Workflow 侧持有并随 Activity 输入下传，**不能在 Activity 里从数据库推算**：
 * 推算会让 Temporal 重试算出不同的轮次、绕过幂等短路，把已放行的工具再执行一遍。
 *
 * ⚠️ 加轮次段改变了标识形状（`…:nodeKey` → `…:nodeKey#0`），因此**此前已落库的
 * `AgentFlowNodeExecution` 记录不再被命中**。影响面：正在途中的 run 若跨这次部署，会把已
 * 完成的节点重跑一遍。部署前应确认无在途 run（判断依据见 `agent-flow.workflow-revision.ts`
 * 的修订号说明），这也是那份文件要求递增修订号的原因。
 */
function createNodeExecutionId(
  input: AgentFlowWorkflowInput,
  nodeKey: string,
  iteration: number,
): string {
  return `${input.streamTaskId}:${input.flowVersionId}:${nodeKey}#${iteration}`;
}

/**
 * 把 Workflow 捕获的异常翻译成可下发的类别与原因
 * @param error catch 到的未知异常
 * @returns 返回协议闭集内的类别与可展示原因
 * @description 此前这里硬编码 `'WORKFLOW_ACTIVITY_FAILED'`——它既不在 `TaskErrorCategory`
 * 闭集内（会污染 task.error 载荷），也把真实原因整段丢掉，用户只剩「流程执行失败」，
 * 排障只能翻 worker 日志。
 *
 * 只有我们自己抛出的 `ApplicationFailure` 才透出 message：其余异常（Prisma、网络库）
 * 的 message 可能含连接串或密钥，一律退回通用文案。
 */
function describeWorkflowFailure(error: unknown): {
  category: TaskErrorCategory;
  reason?: string;
} {
  const failure = findApplicationFailure(error);
  // 只信登记过的类型。Temporal 会把 Activity 里抛出的**普通 Error 也转成
  // ApplicationFailure**（type 取构造函数名，message 原样保留），因此
  // 「是不是 ApplicationFailure」完全不能作为可信依据——一个 Prisma 连接错误会把
  // `postgres://user:pw@host` 直接送进用户可见的错误文案。
  // 白名单同时决定类别与「message 是否可透出」：未登记的类型两者都不给。
  const category = failure?.type
    ? FAILURE_TYPE_CATEGORY[failure.type]
    : undefined;
  if (!category) {
    return { category: 'server' };
  }
  return {
    category,
    ...(failure?.message ? { reason: failure.message } : {}),
  };
}

/**
 * 沿 cause 链找出我们自己抛的 ApplicationFailure
 * @param error catch 到的未知异常
 * @returns 找到则返回该失败，否则返回 undefined
 * @description Activity 抛出的错误在 Workflow 侧被包成 ActivityFailure，真实的
 * ApplicationFailure 挂在 cause 上。直接对顶层做 instanceof 判定会让**所有** Activity
 * 失败都落到 server 兜底，类别与原因一起丢掉。
 */
function findApplicationFailure(
  error: unknown,
): ApplicationFailure | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof ApplicationFailure) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * ApplicationFailure 类型 -> 协议错误类别。
 * @description 配置与快照类问题重试不会变好，归入 invalid；执行器缺失属于服务侧问题。
 * 未登记的类型走 server 兜底，不猜成 invalid——把服务故障说成"请求内容无法处理"会误导用户。
 */
const FAILURE_TYPE_CATEGORY: Readonly<Record<string, TaskErrorCategory>> = {
  AGENT_FLOW_RUNTIME_CONTEXT_INVALID: 'invalid',
  AGENT_FLOW_INVALID_SNAPSHOT: 'invalid',
  AGENT_FLOW_TASK_SNAPSHOT_MISMATCH: 'invalid',
  AGENT_FLOW_APPROVAL_INVALID: 'invalid',
  AGENT_FLOW_APPROVAL_KIND_MISMATCH: 'invalid',
  AGENT_FLOW_NON_RETRYABLE: 'invalid',
  AGENT_FLOW_NODE_EXECUTOR_UNAVAILABLE: 'server',
};
