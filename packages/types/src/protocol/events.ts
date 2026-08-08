/**
 * 流式任务事件类型与信封
 *
 * 唯一事实源：后端 StreamTask 与前端 SSE 消费都从这里引入事件类型、终态集与中文文案，
 * 避免两侧各写一份导致漂移。载荷契约见 `payloads.ts`。
 */

/** 流式任务事件类型 */
export enum StreamTaskEventType {
  /** 已指派本轮回答者（群聊自动路由的结果） */
  AgentRouted = 'agent.routed',
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
  /** 人工审批已处理（通过/拒绝/改参后通过） */
  ApprovalResolved = 'approval.resolved',
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
  [StreamTaskEventType.AgentRouted]: '已指派回答者',
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
  [StreamTaskEventType.ApprovalResolved]: '人工确认已处理',
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
