/**
 * 前后端共享的流式通讯协议契约
 *
 * 目标：后端 StreamTask 与前端 SSE 消费使用同一份事件类型定义，避免两侧手抄字符串常量导致漂移。
 * 迁移阶段 3 会把后端 stream-task-event.types.ts 的完整定义收敛到这里。
 */

/** 流式事件类型 */
export enum StreamEventType {
  StrategySelected = 'strategy.selected',
  SkillSelected = 'skill.selected',
  AgentLoopStart = 'agent.loop.start',
  WorkflowStepStart = 'workflow.step.start',
  WorkflowStepDone = 'workflow.step.done',
  ModelCallStart = 'model.call.start',
  ModelCallDone = 'model.call.done',
  ToolCallStart = 'tool.call.start',
  ToolCallDelta = 'tool.call.delta',
  ToolCallDone = 'tool.call.done',
  ToolCallError = 'tool.call.error',
  MessageDelta = 'message.delta',
  MessageDone = 'message.done',
  /** 预留给 P5 HITL：需要人工审批 */
  ApprovalRequired = 'approval.required',
}

/** 事件通用信封 */
export interface StreamEventEnvelope<TPayload = Record<string, unknown>> {
  type: StreamEventType;
  taskId: string;
  streamId?: string;
  conversationId?: string;
  messageId?: string;
  status?: string;
  payload?: TPayload;
}

/**
 * 事件类型 → 中文展示文案
 * @description 供前端展示 agent 执行状态。用 Record<StreamEventType, string> 保证新增事件时
 * 必须补充对应文案（编译期穷尽校验，漏一个即报错）。
 */
export const STREAM_EVENT_LABELS: Record<StreamEventType, string> = {
  [StreamEventType.StrategySelected]: '已选择执行策略',
  [StreamEventType.SkillSelected]: '已选择技能',
  [StreamEventType.AgentLoopStart]: '开始执行',
  [StreamEventType.WorkflowStepStart]: '步骤开始',
  [StreamEventType.WorkflowStepDone]: '步骤完成',
  [StreamEventType.ModelCallStart]: '正在思考',
  [StreamEventType.ModelCallDone]: '思考完成',
  [StreamEventType.ToolCallStart]: '开始调用工具',
  [StreamEventType.ToolCallDelta]: '工具调用中',
  [StreamEventType.ToolCallDone]: '工具调用完成',
  [StreamEventType.ToolCallError]: '工具调用失败',
  [StreamEventType.MessageDelta]: '正在生成回复',
  [StreamEventType.MessageDone]: '回复完成',
  [StreamEventType.ApprovalRequired]: '待人工确认',
};

/**
 * 获取事件的中文展示文案
 * @param type 事件类型
 * @returns 返回中文文案；未知类型回退为原始类型字符串
 */
export function getStreamEventLabel(type: StreamEventType): string {
  return STREAM_EVENT_LABELS[type] ?? type;
}
