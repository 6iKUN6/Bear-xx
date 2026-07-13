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
}

//终态事件
export const STREAM_TASK_TERMINAL_EVENT_TYPES = new Set<StreamTaskEventType>([
  StreamTaskEventType.TaskCompleted,
  StreamTaskEventType.TaskError,
  StreamTaskEventType.TaskExpired,
  StreamTaskEventType.TaskCanceled,
]);
