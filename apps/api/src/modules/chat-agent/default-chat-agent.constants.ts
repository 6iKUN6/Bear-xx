/**
 * 默认 ReAct 智能体的固定身份与运行护栏
 * @description 纯常量文件：Temporal Workflow 运行在隔离 VM 中，也要读取时长上限，因此这里不能引入任何
 * Node、Nest 或数据库依赖。智能体本体（提示词、工具、模型调用）见 default-chat.agent.ts。
 */

/** 事件、审批与节点执行记录归属的固定节点键。 */
export const DEFAULT_CHAT_AGENT_NODE_KEY = 'chat';

/** 轨迹中展示的节点标题。 */
export const DEFAULT_CHAT_AGENT_TITLE = '默认助手';

/**
 * 单个任务的运行护栏
 * @description 与 FlowDefinition.policy 同义，但由代码维护：模型调用与工具调用跨审批恢复累计，
 * maxToolIterations 换算为 LangGraph recursionLimit，maxDurationSeconds 由 Workflow 计时。
 */
export const DEFAULT_CHAT_AGENT_LIMITS = {
  maxModelCalls: 24,
  maxToolCalls: 16,
  maxToolIterations: 8,
  maxDurationSeconds: 1800,
} as const;

/**
 * 默认智能体在一个任务内唯一的执行标识
 * @param streamTaskId 当前任务 ID
 * @returns 返回幂等记录、上下文快照、LangGraph thread 与轨迹共用的执行标识
 * @description 一个任务只有一次智能体执行，审批恢复沿用同一标识，才能命中同一份 checkpoint 与上下文快照。
 */
export function createChatAgentExecutionId(streamTaskId: string): string {
  return `${streamTaskId}:${DEFAULT_CHAT_AGENT_NODE_KEY}#0`;
}
