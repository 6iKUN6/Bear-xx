import type { FlowNodeType } from '@litter-bear/types/agent-flow';
import type { TaskErrorCategory } from '@litter-bear/types/protocol';

/** 启动一次 AgentFlow Workflow 所需的最小业务标识。 */
export interface AgentFlowWorkflowInput {
  streamTaskId: string;
  flowVersionId: string;
  flowDigest: string;
  activityTaskQueue: string;
}

/** HTTP 派发器启动 Workflow 所需的业务快照，不暴露运行时队列配置。 */
export type AgentFlowWorkflowStartInput = Omit<
  AgentFlowWorkflowInput,
  'activityTaskQueue'
>;

/**
 * 影响 Flow 下一跳的分支键
 * @description 从闭集联合泛化为字符串：condition 节点的分支键由 Definition 声明（case_* 与 else），
 * 类型系统无法枚举。合法性由发布期校验（每个声明分支都必须有出边，或都没有）与
 * `next` 表的完备性共同保证；Workflow 侧查不到对应出边即视为该分支为终点。
 */
export type AgentFlowNodeOutcome = string;

/**
 * 存入 Temporal History 的最小节点投影
 * @description `next` 的值是**数组**而不是单个键：同一个 default 分支可以有多条出边，那就是
 * 并行扇出。此前是 `Record<string, string>`，一个分支键只存得下一个目标，扇出会被静默丢掉。
 * join 的 waitFor 与 policy 也要进快照——汇聚判定发生在 Workflow 侧，它不能回头查数据库。
 */
export interface AgentFlowWorkflowNode {
  key: string;
  type: FlowNodeType;
  next: Readonly<Record<string, readonly string[]>>;
  /** 仅 join 节点有：要等待哪些节点、等多少个 */
  join?: { waitFor: readonly string[]; policy: 'all' | 'any' };
}

/** 从数据库冻结版本转换出的脱敏执行快照。 */
export interface AgentFlowRunSnapshot {
  entryNodeKey: string;
  maxDurationSeconds: number;
  nodes: readonly AgentFlowWorkflowNode[];
}

/** Activity 执行节点时所需的稳定身份。 */
export interface AgentFlowNodeExecutionInput {
  workflow: AgentFlowWorkflowInput;
  nodeKey: string;
  nodeExecutionId: string;
}

/** Activity 恢复人工等待节点时所需的稳定身份。 */
export interface AgentFlowNodeResumeInput extends AgentFlowNodeExecutionInput {
  approvalId: string;
}

/** 节点正常结束并请求 Workflow 选择下一条边。 */
export interface AgentFlowNodeCompletedResult {
  kind: 'completed';
  outcome: AgentFlowNodeOutcome;
  summary?: string;
}

/** 节点已持久化审批事实，Workflow 必须等待对应 Signal。 */
export interface AgentFlowNodeWaitingHumanResult {
  kind: 'waiting_human';
  approvalId: string;
  timeoutSeconds: number;
}

/** 节点主动结束 Flow，避免以不存在的边伪装成功。 */
export interface AgentFlowNodeStoppedResult {
  kind: 'stopped';
  status: 'completed' | 'cancelled' | 'error';
  errorCategory?: TaskErrorCategory;
}

/**
 * 节点尚未结束，Workflow 需继续调度同一节点推进下一步。
 * @description plan-loop 每步都是一次完整模型调用；整条循环压在单次 Activity 里会
 * 逼近 startToCloseTimeout，且循环期间 Workflow 既查不到 deadline 也收不到取消。
 * 改为一步一次 Activity 后，`completedSteps` 让 Workflow 能断言每次调度确有推进。
 */
export interface AgentFlowNodeContinuedResult {
  kind: 'continued';
  completedSteps: number;
}

/** 节点执行或恢复后的受限结果。 */
export type AgentFlowNodeExecutionResult =
  | AgentFlowNodeCompletedResult
  | AgentFlowNodeWaitingHumanResult
  | AgentFlowNodeContinuedResult
  | AgentFlowNodeStoppedResult;

/** Workflow 通过 Activity 收敛业务任务时写入的终态。 */
export type AgentFlowFinalStatus =
  'completed' | 'cancelled' | 'timed_out' | 'error';

/** 任务收尾 Activity 的最小输入。 */
export interface AgentFlowFinalizeRunInput {
  workflow: AgentFlowWorkflowInput;
  status: AgentFlowFinalStatus;
  lastNodeKey: string | null;
  /** 必须落在协议闭集内：它会直接进入下发给前端的 task.error 载荷 */
  errorCategory?: TaskErrorCategory;
  /**
   * 可展示的失败原因
   * @description 只允许来自我们自己抛出的 ApplicationFailure 文案。第三方错误（Prisma、
   * 网络库）的 message 可能含连接串或密钥，一律不透出，退回通用文案。
   */
  errorReason?: string;
}

/** Temporal Workflow 可调用的 Activity 闭集。 */
export interface AgentFlowActivityApi {
  loadRunSnapshot(input: AgentFlowWorkflowInput): Promise<AgentFlowRunSnapshot>;
  executeNode(
    input: AgentFlowNodeExecutionInput,
  ): Promise<AgentFlowNodeExecutionResult>;
  /** 继续推进已开始但未结束的节点；不重发节点开始事件。 */
  continueNode(
    input: AgentFlowNodeExecutionInput,
  ): Promise<AgentFlowNodeExecutionResult>;
  resumeNode(
    input: AgentFlowNodeResumeInput,
  ): Promise<AgentFlowNodeExecutionResult>;
  finalizeRun(input: AgentFlowFinalizeRunInput): Promise<void>;
}

/** 审批 Signal 的脱敏载荷。 */
export interface AgentFlowApprovalSignalInput {
  approvalId: string;
}

/** Workflow 返回给调用方的最终结果。 */
export interface AgentFlowWorkflowResult {
  status: AgentFlowFinalStatus;
  lastNodeKey: string | null;
}
