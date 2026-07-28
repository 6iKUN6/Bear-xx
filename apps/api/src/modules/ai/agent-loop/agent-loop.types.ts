import { StreamTaskEventType } from '../../stream-task/stream-task-event.types';
import type { LlmMessage, ResolvedLlmTextRequest } from '../../llm/llm.types';
import type { CommonChatAgentStreamEvent } from '../agents/common-chat-agent';

export enum AgentStrategyMode {
  Direct = 'direct',
  ReAct = 'react',
  PlanExecute = 'plan_execute',
  Hybrid = 'hybrid',
}

/** agent 默认策略：'auto' = 在 allowedStrategies 内路由；具体值 = 强制该模式 */
export type AgentDefaultStrategy = 'auto' | AgentStrategyMode;

/**
 * 运行时智能体定义
 * @description 由 AgentDefinitionService 从 DB（或合成默认）解析，驱动执行链路。
 * 语义："空/auto/null = 不覆盖"，复刻当前消息驱动的默认行为，而非"空集"。
 */
export interface AgentDefinition {
  /** 系统提示词；null → 回退到 chatAgentCommonPrompt（.md，在 runner 内解析） */
  systemPrompt: string | null;
  /** 模型预设 id；null → 回退请求 llm */
  modelPreset: string | null;
  /** 默认/强制策略 */
  defaultStrategy: AgentDefaultStrategy;
  /** 允许使用的策略集合（须是已安装闭集子集）；[] = 不限制 */
  allowedStrategies: AgentStrategyMode[];
  /** 允许的工具组；[] = 不覆盖 */
  toolGroups: string[];
  /** 附加技能；[] = 不覆盖 */
  skills: string[];
  /** 步数预算；null = 不覆盖 */
  maxSteps: number | null;
}

export interface AgentLoopInput {
  messages: LlmMessage[];
  systemPrompt?: string;
  llm?: ResolvedLlmTextRequest;
  /**
   * 本次执行的工具集。
   * @description 路由后由 CapabilityResolver 依据策略决策装配；调用方无需传入。
   */
  tools?: unknown[];
  /**
   * 本次执行的步数/迭代预算。
   * @description 路由后由 AgentLoopRunner 从策略决策注入；Plan/Hybrid controller 用作步骤上限。
   */
  maxSteps?: number;
  /**
   * HITL 会话标识（用作 checkpointer 的 thread_id）。
   * @description 由任务层注入（= taskId）；存在且有需审批工具时才启用中断/恢复。
   */
  threadId?: string;
  /**
   * 本次装配中需要人工审批的工具名。
   * @description 路由后由 CapabilityResolver 产出；驱动 HITL 中间件的 interruptOn。
   */
  approvalToolNames?: string[];
  /**
   * 数据化智能体配置。
   * @description 存在时覆盖路由/装配（空/auto 字段 = 不覆盖）；缺省 = 当前默认行为。
   */
  agentConfig?: AgentDefinition;
  abortSignal?: AbortSignal;
}

export interface AgentStrategyDecision {
  mode: AgentStrategyMode;
  confidence: number;
  reason: string;
  skills: string[];
  toolGroups: string[];
  maxSteps: number;
  publicStatus: string;
}

export interface AgentStrategyGraph {
  readonly mode: AgentStrategyMode;

  /**
   * 执行策略图
   * @param input agent loop 输入上下文
   * @returns 返回统一 agent loop 事件流
   * @description 每个策略图只负责自己的执行编排，并统一输出 StreamTask 可消费的事件。
   */
  stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown>;
}

export interface AgentLoopWorkflowEvent {
  type:
    | StreamTaskEventType.AgentLoopStart
    | StreamTaskEventType.StrategySelected
    | StreamTaskEventType.SkillSelected
    | StreamTaskEventType.WorkflowStepStart
    | StreamTaskEventType.WorkflowStepDone
    | StreamTaskEventType.ModelCallStart
    | StreamTaskEventType.ModelCallDone;
  payload: Record<string, unknown>;
}

export type AgentLoopStreamEvent =
  CommonChatAgentStreamEvent | AgentLoopWorkflowEvent;
