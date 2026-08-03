/**
 * 前后端共享的流式通讯协议契约
 *
 * 唯一事实源：后端 StreamTask 与前端 SSE 消费都从这里引入事件类型、终态集与中文文案，
 * 避免两侧各写一份导致漂移。
 */

/** 流式任务事件类型 */
export enum StreamTaskEventType {
  /** Agent Loop 开始执行 */
  AgentLoopStart = 'agent.loop.start',
  /** 已选择本次任务的执行策略 */
  StrategySelected = 'strategy.selected',
  /** 已选择本次任务需要使用的业务能力 */
  SkillSelected = 'skill.selected',
  /** 工作流步骤开始执行 */
  WorkflowStepStart = 'workflow.step.start',
  /** 工作流步骤执行完成 */
  WorkflowStepDone = 'workflow.step.done',
  /** 模型调用开始 */
  ModelCallStart = 'model.call.start',
  /** 模型调用完成 */
  ModelCallDone = 'model.call.done',
  /** 工具调用开始 */
  ToolCallStart = 'tool.call.start',
  /** 工具调用参数或过程增量 */
  ToolCallDelta = 'tool.call.delta',
  /** 工具调用完成 */
  ToolCallDone = 'tool.call.done',
  /** 工具调用失败 */
  ToolCallError = 'tool.call.error',
  /** 助手消息文本增量 */
  MessageDelta = 'message.delta',
  /** 助手消息生成完成 */
  MessageDone = 'message.done',
  /** 流式任务已创建 */
  TaskCreated = 'task.created',
  /** 流式任务开始执行 */
  TaskStarted = 'task.started',
  /** 流式任务执行完成 */
  TaskCompleted = 'task.completed',
  /** 流式任务执行失败 */
  TaskError = 'task.error',
  /** 流式任务已过期 */
  TaskExpired = 'task.expired',
  /** 流式任务已取消 */
  TaskCanceled = 'task.canceled',
  /** 需要人工审批（P5 HITL 预留） */
  ApprovalRequired = 'approval.required',
  /** 会话标题已生成（新会话首轮与主回答并行生成后下发） */
  ConversationTitleUpdated = 'conversation.title.updated',
}

/** 终态事件集合 */
export const STREAM_TASK_TERMINAL_EVENT_TYPES = new Set<StreamTaskEventType>([
  StreamTaskEventType.TaskCompleted,
  StreamTaskEventType.TaskError,
  StreamTaskEventType.TaskExpired,
  StreamTaskEventType.TaskCanceled,
]);

/** 事件通用信封 */
export interface StreamTaskEventEnvelope<TPayload = Record<string, unknown>> {
  type: StreamTaskEventType;
  taskId: string;
  streamId?: string;
  conversationId?: string;
  messageId?: string;
  status?: string;
  payload?: TPayload;
}

/**
 * 事件类型 → 中文展示文案
 * @description 供前端展示 agent 执行状态。用 Record<StreamTaskEventType, string> 保证新增事件时
 * 必须补充对应文案（编译期穷尽校验，漏一个即报错）。
 */
export const STREAM_TASK_EVENT_LABELS: Record<StreamTaskEventType, string> = {
  [StreamTaskEventType.AgentLoopStart]: '正在分析任务',
  [StreamTaskEventType.StrategySelected]: '已选择执行策略',
  [StreamTaskEventType.SkillSelected]: '已选择能力',
  [StreamTaskEventType.WorkflowStepStart]: '正在执行步骤',
  [StreamTaskEventType.WorkflowStepDone]: '步骤已完成',
  [StreamTaskEventType.ModelCallStart]: '正在请求模型',
  [StreamTaskEventType.ModelCallDone]: '模型响应完成',
  [StreamTaskEventType.ToolCallStart]: '正在调用工具',
  [StreamTaskEventType.ToolCallDelta]: '工具调用中',
  [StreamTaskEventType.ToolCallDone]: '工具调用完成',
  [StreamTaskEventType.ToolCallError]: '工具调用失败',
  [StreamTaskEventType.MessageDelta]: '正在生成回复',
  [StreamTaskEventType.MessageDone]: '回复生成完成',
  [StreamTaskEventType.TaskCreated]: '任务已创建',
  [StreamTaskEventType.TaskStarted]: '任务已开始',
  [StreamTaskEventType.TaskCompleted]: '已完成',
  [StreamTaskEventType.TaskError]: '任务执行失败',
  [StreamTaskEventType.TaskExpired]: '任务已过期',
  [StreamTaskEventType.TaskCanceled]: '任务已取消',
  [StreamTaskEventType.ApprovalRequired]: '待人工确认',
  [StreamTaskEventType.ConversationTitleUpdated]: '已生成会话标题',
};

/**
 * 获取事件的中文展示文案
 * @param type 事件类型
 * @returns 返回中文文案；未知类型回退为原始类型字符串
 */
export function getStreamTaskEventLabel(type: StreamTaskEventType): string {
  return STREAM_TASK_EVENT_LABELS[type] ?? type;
}

/**
 * LLM / 任务失败的错误类别
 * @description 前后端共享的错误分类，用于前端按类别展示不同文案与是否提供「重试」。
 * - rate_limit：限流（HTTP 429）
 * - auth：鉴权/权限失败（401/403）
 * - timeout：请求超时
 * - network：网络中断/连接错误
 * - invalid：请求参数或内容非法（400/422）
 * - server：服务端错误（5xx）
 * - unknown：无法归类
 */
export type TaskErrorCategory =
  | 'rate_limit'
  | 'auth'
  | 'timeout'
  | 'network'
  | 'invalid'
  | 'server'
  | 'unknown';

/**
 * task.error 事件的结构化载荷
 * @description 在扁平 `errorMessage` 之外，额外下发错误类别与是否可重试，供前端差异化处理。
 */
export interface TaskErrorPayload {
  /** 错误类别 */
  category: TaskErrorCategory;
  /** 是否属于可重试类别（限流/超时/网络/5xx 为 true） */
  retryable: boolean;
  /** 原始 HTTP 状态码（如有） */
  status?: number;
}

/**
 * 错误类别 → 中文展示文案
 * @description 用 Record 保证新增类别时必须补文案（编译期穷尽校验）。
 */
export const TASK_ERROR_CATEGORY_LABELS: Record<TaskErrorCategory, string> = {
  rate_limit: '请求太频繁，请稍后重试',
  auth: '服务鉴权失败，请联系管理员',
  timeout: '响应超时，请重试',
  network: '网络异常，请检查连接后重试',
  invalid: '请求内容无法处理，请调整后再试',
  server: '服务暂时不可用，请稍后重试',
  unknown: '生成失败，请重试',
};

/**
 * 获取错误类别的中文展示文案
 * @param category 错误类别
 * @returns 返回中文文案；未知类别回退为 unknown 文案
 */
export function getTaskErrorCategoryLabel(
  category: TaskErrorCategory | undefined,
): string {
  return category
    ? (TASK_ERROR_CATEGORY_LABELS[category] ??
        TASK_ERROR_CATEGORY_LABELS.unknown)
    : TASK_ERROR_CATEGORY_LABELS.unknown;
}

/**
 * conversation.title.updated 事件载荷
 * @description 新会话首轮时后端与主回答并行生成 AI 标题，生成后通过当前任务的
 * SSE 流下发，前端可在回答流式输出期间就更新会话标题展示。
 */
export interface ConversationTitleUpdatedPayload {
  /** 会话 id */
  conversationId: string;
  /** 生成的标题 */
  title: string;
}

/** 人工审批决定类型（P5 HITL） */
export type ApprovalDecisionType = 'approve' | 'reject' | 'edit';

/**
 * approval.required 事件载荷
 * @description 工具执行前需要人工确认时下发给前端，用于展示审批卡片。
 */
export interface ApprovalRequiredPayload {
  /** 触发审批的工具调用 id */
  toolCallId?: string;
  /** 工具名 */
  toolName?: string;
  /** 序列化后的工具入参（供展示，edit 时可改） */
  args?: string;
  /** 面向用户的审批说明 */
  description?: string;
  /** 允许的决定（approve/reject/edit 的子集） */
  allowedDecisions: ApprovalDecisionType[];
  index?: number;
  nodeKey?: string;
  traceKey?: string;
  publicStatus?: string;
}

/**
 * 人工审批决定（前端提交、后端恢复时消费）
 * @description approve 直接执行；reject 跳过并回注拒绝；edit 用 editedArgs 替换入参后执行。
 */
export interface ApprovalDecision {
  decision: ApprovalDecisionType;
  /** edit 时的新入参 */
  editedArgs?: Record<string, unknown>;
  /** reject 时可选的说明 */
  reason?: string;
}
