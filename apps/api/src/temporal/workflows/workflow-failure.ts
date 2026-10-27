import { ApplicationFailure } from '@temporalio/workflow';
import type { TaskErrorCategory } from '@litter-bear/types/protocol';

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
export function describeWorkflowFailure(error: unknown): {
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
  AGENT_FLOW_CONTEXT_BUDGET_EXCEEDED: 'budget_exceeded',
  AGENT_FLOW_CONTEXT_ERROR: 'server',
  AGENT_FLOW_INVALID_SNAPSHOT: 'invalid',
  AGENT_FLOW_TASK_SNAPSHOT_MISMATCH: 'invalid',
  AGENT_FLOW_APPROVAL_INVALID: 'invalid',
  AGENT_FLOW_APPROVAL_KIND_MISMATCH: 'invalid',
  AGENT_FLOW_NON_RETRYABLE: 'invalid',
  AGENT_FLOW_NODE_EXECUTOR_UNAVAILABLE: 'server',
  AGENT_FLOW_LLM_TIMEOUT: 'timeout',
};
