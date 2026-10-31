import {
  ApplicationFailure,
  ActivityCancellationType,
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { TaskErrorCategory } from '@litter-bear/types/protocol';
import { describeWorkflowFailure } from './workflow-failure';
import type {
  AgentFlowActivityApi,
  AgentFlowApprovalSignalInput,
  AgentFlowFinalStatus,
  AgentFlowNodeCompletedResult,
  AgentFlowNodeExecutionInput,
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
  const renderActivities = createRenderActivities(input.activityTaskQueue);
  const longActivities = createLongActivities(input.activityTaskQueue);
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
      iteration: number,
    ): Promise<{
      node: AgentFlowWorkflowNode;
      result: SettledNodeResult;
      iteration: number;
    }> => {
      const node = getSnapshotNode(nodesByKey, nodeKey);
      lastNodeKey = node.key;
      const nodeExecutionId = createNodeExecutionId(input, node.key, iteration);
      // 渲染走独立的长超时代理；声明渲染工具组的 agent/plan-loop 节点走 executeLongNode，
      // 其余节点保持原来的 5 分钟。非 longRunning 节点与旧版本逐条一致，因此在途 run 仍可重放。
      const nodeInput = {
        workflow: input,
        nodeKey: node.key,
        nodeExecutionId,
        iteration,
      };
      let result =
        node.type === 'render'
          ? patched('render-cancellation-v1')
            ? await executeCancellableRender(
                renderActivities.renderNode,
                nodeInput,
                () => cancelled,
                deadlineMs,
              )
            : await renderActivities.renderNode(nodeInput)
          : node.longRunning
            ? await longActivities.executeLongNode(nodeInput)
            : await activities.executeNode(nodeInput);

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
            iteration,
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
          iteration,
          approvalId: waitingResult.approvalId,
        });
      }
      return { node, result, iteration };
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
    /** 每个节点下一次调度所属的轮次；不在循环体内时缺省为 0 */
    const iterations = new Map<string, number>();
    /** 正在推进中的节点；键排序后参与 race，保证重放时的调度顺序一致 */
    const inFlight = new Map<
      string,
      Promise<{
        key: string;
        node: AgentFlowWorkflowNode;
        result: SettledNodeResult;
        iteration: number;
      }>
    >();

    const launch = (nodeKey: string): void => {
      const iteration = iterations.get(nodeKey) ?? 0;
      scheduled.add(nodeKey);
      inFlight.set(
        nodeKey,
        advanceNode(nodeKey, iteration).then((settled) => ({
          key: nodeKey,
          ...settled,
        })),
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

      if (settled.node.type === 'loop' && settled.result.outcome === 'again') {
        const body = settled.node.loop?.body;
        if (!body || body.length === 0) {
          throw ApplicationFailure.nonRetryable(
            `循环节点「${settled.node.key}」缺少循环体快照`,
            'AGENT_FLOW_INVALID_SNAPSHOT',
          );
        }
        const nextIteration = settled.iteration + 1;
        // 下一轮必须重新调度循环体并重新等待体内 join。loop 本身也要清掉，否则回边到达时
        // scheduled 会把下一次判定误当成同一轮重复调度而跳过。
        for (const member of [...body, settled.node.key]) {
          scheduled.delete(member);
          completed.delete(member);
          iterations.set(member, nextIteration);
        }
      }

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
 * 创建渲染节点专用的 Activity 代理
 * @param activityTaskQueue 由启动输入冻结的业务 Activity 队列名
 * @returns 返回只含 renderNode 的 Activity 集合
 * @description 单次渲染可能持续数十分钟，必须与普通节点分开配置：
 *
 * - `startToCloseTimeout` 30 分钟，覆盖 15–25 分钟的长成片；
 * - `heartbeatTimeout` 30 秒，Activity 全生命周期持续心跳，帧进度另行上报；
 * - 取消等待 Activity 确认停止后才收敛，避免帧目录和上传仍在后台继续；
 * - `maximumAttempts` 2，有限重试：重试会复用同一个对象 key，命中已存在的成片即短路，
 *   因此第二次尝试的代价通常只有一次 HEAD 请求。
 */
function createRenderActivities(
  activityTaskQueue: string,
): Pick<AgentFlowActivityApi, 'renderNode'> {
  return proxyActivities<Pick<AgentFlowActivityApi, 'renderNode'>>({
    taskQueue: activityTaskQueue,
    startToCloseTimeout: '30 minutes',
    heartbeatTimeout: '30 seconds',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      initialInterval: '5 seconds',
      maximumInterval: '30 seconds',
      maximumAttempts: 2,
      nonRetryableErrorTypes: [
        'AGENT_FLOW_INVALID_SNAPSHOT',
        'AGENT_FLOW_RENDER_WORKER_ROLE',
        'AGENT_FLOW_RENDER_HTML_MISSING',
        'AGENT_FLOW_RENDER_INVALID_PARAMETERS',
        'AGENT_FLOW_RENDER_HTML_TOO_LARGE',
        'AGENT_FLOW_RENDER_CHROME_NOT_FOUND',
        'AGENT_FLOW_RENDER_FRAME_API_MISSING',
        'AGENT_FLOW_RENDER_CONFIG_INVALID',
        'AGENT_FLOW_RENDER_VERSIONING_UNSAFE',
        'AGENT_FLOW_RENDER_OBJECT_CONFLICT',
        'AGENT_FLOW_RENDER_ABORTED',
      ],
    },
  });
}

/**
 * 创建长任务 agent / plan-loop 节点专用的 Activity 代理
 * @param activityTaskQueue 由启动输入冻结的业务 Activity 队列名
 * @returns 返回只含 executeLongNode 的 Activity 集合
 * @description 声明了渲染工具组的节点，工具循环里可能执行数分钟渲染，必须与普通节点的
 * 5 分钟超时分开配置；心跳覆盖整个 agent 循环，重试策略与普通 executeNode 一致。
 */
function createLongActivities(
  activityTaskQueue: string,
): Pick<AgentFlowActivityApi, 'executeLongNode'> {
  return proxyActivities<Pick<AgentFlowActivityApi, 'executeLongNode'>>({
    taskQueue: activityTaskQueue,
    startToCloseTimeout: '30 minutes',
    heartbeatTimeout: '30 seconds',
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
 * 在渲染期间响应业务取消及本张 Flow 的剩余时长
 * @param renderNode 独立渲染 Activity 代理
 * @param input 仅包含稳定执行标识的入参
 * @param isCancelled 当前是否收到业务取消 Signal
 * @param deadlineMs 本张 Flow 的截止时间
 * @returns 返回渲染结果；中断时等待 Activity 停止后抛出对应终态哨兵
 * @description 仅 render 分支使用并由 patch 保护旧 History；不改变普通节点的命令序列和预算。
 * 渲染结束后取消本次定时等待，不遗留长 Timer。原生取消仍由外层 Workflow 收敛。
 */
async function executeCancellableRender(
  renderNode: AgentFlowActivityApi['renderNode'],
  input: AgentFlowNodeExecutionInput,
  isCancelled: () => boolean,
  deadlineMs: number,
): Promise<AgentFlowNodeExecutionResult> {
  return CancellationScope.cancellable(async () => {
    const scope = CancellationScope.current();
    const rendering = renderNode(input);
    const interrupted = condition(
      isCancelled,
      Math.max(1, deadlineMs - Date.now()),
    ).then(() => ({ interrupted: true as const }));
    try {
      const winner = await Promise.race([
        rendering.then((result) => ({ result })),
        interrupted,
      ]);
      if ('result' in winner) {
        if (isCancelled()) throw new RunHaltedError('cancelled');
        if (Date.now() >= deadlineMs) throw new RunHaltedError('timed_out');
        return winner.result;
      }
      scope.cancel();
      try {
        await rendering;
      } catch {
        // 已确定的业务取消/超时优先；这里仍等待 Activity 的终态，不把停止记成成功。
      }
      throw new RunHaltedError(isCancelled() ? 'cancelled' : 'timed_out');
    } catch (error) {
      if (
        isCancellation(error) &&
        patched('render-native-cancellation-wait-v1')
      ) {
        // 原生取消会先拒绝 condition，不会等 renderNode 的 WAIT_CANCELLATION_COMPLETED。
        // 必须显式等 Activity 的异步资源清理完成，才能让外层调度 nonCancellable 终态写入。
        // 单独的 patch 保留 r8 原生取消 History 的旧命令顺序。
        scope.cancel();
        try {
          await rendering;
        } catch {
          // 保留原生取消原因；这里只等待停止确认，不把清理中的失败替换成成功。
        }
      }
      throw error;
    } finally {
      scope.cancel();
    }
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
