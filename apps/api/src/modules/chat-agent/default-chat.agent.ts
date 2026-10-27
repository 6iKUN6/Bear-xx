import { Injectable } from '@nestjs/common';
import {
  AgentStrategyMode,
  type ApprovalDecision,
} from '@litter-bear/types/protocol';
import type { ReasoningSelection } from '@litter-bear/types';
import { chatAgentCommonPrompt } from '../../prompts';
import { CapabilityResolver } from '../ai/agent-loop/capability/capability.resolver';
import { CommonChatAgentService } from '../ai/agents';
import type { CommonChatAgentStreamEvent } from '../ai/agents/common-chat-agent/common-chat-agent.types';
import type { LlmMessage, LlmVisionRequestTransform } from '../llm/llm.types';
import type { ModelContextEnvelope } from '../llm/model-context.schema';
import { AGENT_FLOW_MODEL_RUNTIME } from '../agent-flow/runtime/agent-run.support';
import { DEFAULT_CHAT_AGENT_LIMITS } from './default-chat-agent.constants';

/** 一次运行装配出的工具与系统提示词。 */
export interface DefaultChatAgentAssembly {
  systemPrompt: string;
  tools: unknown[];
  approvalToolNames: string[];
}

/** 驱动一次 ReAct 运行所需的全部输入；首轮与审批恢复必须给出同一份。 */
export interface DefaultChatAgentTurn {
  modelPreset: string;
  reasoning?: ReasoningSelection;
  assembly: DefaultChatAgentAssembly;
  /** 已冻结的上下文快照：历史、本轮用户消息与可能的图片 */
  messages: LlmMessage[];
  /** 快照里经上下文预算处理后的系统提示词 */
  systemPrompt: string;
  inputTokenLimit: number;
  maxOutputTokens: number;
  /** LangGraph checkpoint 的 thread_id；审批恢复靠它回到中断处 */
  threadId: string;
  onModelTurn: () => void;
  onSummaryModelCall: () => Promise<void>;
  onCompletedModelContext: (context: ModelContextEnvelope) => void;
  visionTransform?: LlmVisionRequestTransform;
  /** 已持久化的工具审批决定；有值即为恢复 */
  decision?: ApprovalDecision;
}

/**
 * 代码定义的默认 ReAct 智能体
 * @description 未绑定 Flow 的智能体都由它回答。它就是一个 LangChain `createAgent` ReAct 循环
 * （经 CommonChatAgentService 创建，复用其模型构建、HITL 中间件、工具上下文压缩与供应商私有上下文提取），
 * 在这里用代码固定：
 * - 系统提示词：智能体人设（未填写时用通用聊天提示词）+ 工具组附带的能力说明；
 * - 工具：后台为该智能体勾选、并在任务创建时锁定的工具组，经 CapabilityResolver 闭集装配；
 * - 审批：工具注册时声明 requiresApproval 的，由 HITL 中间件在执行前中断；
 * - 护栏：DEFAULT_CHAT_AGENT_LIMITS，工具往返轮数换算为 recursionLimit。
 *
 * 它只描述「智能体是什么」，不碰数据库、事件或 Temporal；持久化与恢复由 ChatAgentActivities 负责。
 */
@Injectable()
export class DefaultChatAgent {
  constructor(
    private readonly capabilityResolver: CapabilityResolver,
    private readonly commonChatAgentService: CommonChatAgentService,
  ) {}

  /**
   * 装配本次运行的工具与系统提示词
   * @param input 任务所属用户、智能体人设与锁定的工具组
   * @returns 返回工具、审批工具名与合并后的系统提示词
   * @description 工具组为空（未配置或模型能力降级）时得到一个纯问答智能体。
   */
  async assemble(input: {
    userId: string;
    agentSystemPrompt: string | null;
    toolGroups: readonly string[];
  }): Promise<DefaultChatAgentAssembly> {
    const capabilities = await this.capabilityResolver.resolve(
      {
        mode: AgentStrategyMode.ReAct,
        confidence: 1,
        reason: '默认助手按智能体锁定的工具组装配',
        skills: [],
        toolGroups: [...input.toolGroups],
        maxSteps: DEFAULT_CHAT_AGENT_LIMITS.maxToolIterations,
        publicStatus: '默认助手',
        source: 'forced',
      },
      input.userId,
    );
    const base =
      input.agentSystemPrompt?.trim() || chatAgentCommonPrompt.trim();
    return {
      systemPrompt: [
        base,
        ...capabilities.systemPromptAdditions.map((item) => item.trim()),
      ]
        .filter((item) => item.length > 0)
        .join('\n\n'),
      tools: capabilities.tools,
      approvalToolNames: capabilities.approvalToolNames,
    };
  }

  /**
   * 运行或恢复一次 ReAct 循环
   * @param turn 模型、上下文快照、工具与回调
   * @returns 返回结构化事件流：正文增量、工具生命周期、审批请求
   * @description 有 decision 时从 checkpoint 中断处恢复，否则从头开始；两者使用同一份模型、工具与消息，
   * LangGraph 才能把恢复对上原来的图状态。
   */
  run(
    turn: DefaultChatAgentTurn,
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const request = {
      modelPreset: turn.modelPreset,
      reasoning: turn.reasoning,
      messages: turn.messages,
      systemPrompt: turn.systemPrompt,
      contextBudget: {
        inputTokenLimit: turn.inputTokenLimit,
        onSummaryModelCall: turn.onSummaryModelCall,
      },
      generation: { maxOutputTokens: turn.maxOutputTokens },
      tools: turn.assembly.tools,
      threadId: turn.threadId,
      approvalToolNames: turn.assembly.approvalToolNames,
      maxToolIterations: DEFAULT_CHAT_AGENT_LIMITS.maxToolIterations,
      onModelTurn: turn.onModelTurn,
      modelRuntime: AGENT_FLOW_MODEL_RUNTIME,
      onCompletedModelContext: turn.onCompletedModelContext,
      ...(turn.visionTransform
        ? { visionTransform: turn.visionTransform }
        : {}),
    };
    return turn.decision
      ? this.commonChatAgentService.resumeEvents({
          ...request,
          decision: turn.decision,
        })
      : this.commonChatAgentService.streamEvents(request);
  }
}
