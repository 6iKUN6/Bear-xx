import { StreamTaskEventType } from '../../stream-task/stream-task-event.types';
import {
  AgentStrategyMode,
  type StreamTaskWireEvent,
} from '@litter-bear/types/protocol';
import type { LlmMessage, ResolvedLlmTextRequest } from '../../llm/llm.types';
import type { CommonChatAgentStreamEvent } from '../agents/common-chat-agent';

/**
 * 执行策略闭集
 * @description 定义已收敛到共享包 @litter-bear/types/protocol——策略标识会随
 * strategy.selected / workflow.step.* 下发给前端展示。本处仅 re-export，
 * 保持既有相对路径 import 不变。
 */
export { AgentStrategyMode };

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

/**
 * 策略决策来源
 * @description model=结构化 LLM 路由生效；rules=降级到关键词规则；
 * forced=agent 配置强制指定；resume=HITL 恢复按配置装配。
 * LLM 路由失败是静默降级的，不标记则无法区分「模型判定用 direct」和
 * 「模型挂了退到规则」——两者线上表现相同，需要此字段观测真实生效率。
 */
export type AgentStrategySource = 'model' | 'rules' | 'forced' | 'resume';

export interface AgentStrategyDecision {
  mode: AgentStrategyMode;
  confidence: number;
  reason: string;
  skills: string[];
  toolGroups: string[];
  maxSteps: number;
  publicStatus: string;
  source: AgentStrategySource;
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

/** 编排层自行发射的事件类型（其余事件由 agent 层产出） */
type AgentLoopWorkflowEventType =
  | StreamTaskEventType.AgentLoopStart
  | StreamTaskEventType.StrategySelected
  | StreamTaskEventType.SkillSelected
  | StreamTaskEventType.WorkflowStepStart
  | StreamTaskEventType.WorkflowStepDone
  | StreamTaskEventType.ModelCallStart
  | StreamTaskEventType.ModelCallDone;

/**
 * 编排层事件
 * @description 从共享包的线上事件判别联合中切出编排层负责的那几类，
 * 使 type 与 payload 绑定——写错字段名或漏字段直接编译报错，
 * 不再是先前的 `payload: Record<string, unknown>`（前端靠猜字段）。
 */
export type AgentLoopWorkflowEvent = Extract<
  StreamTaskWireEvent,
  { type: AgentLoopWorkflowEventType }
>;

export type AgentLoopStreamEvent =
  CommonChatAgentStreamEvent | AgentLoopWorkflowEvent;
