import { StreamTaskEventType } from '../../stream-task/stream-task-event.types';
import type { LlmMessage, ResolvedLlmTextRequest } from '../../llm/llm.types';
import type { CommonChatAgentStreamEvent } from '../agents/common-chat-agent';

export enum AgentStrategyMode {
  Direct = 'direct',
  ReAct = 'react',
  PlanExecute = 'plan_execute',
  Hybrid = 'hybrid',
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
  | CommonChatAgentStreamEvent
  | AgentLoopWorkflowEvent;
