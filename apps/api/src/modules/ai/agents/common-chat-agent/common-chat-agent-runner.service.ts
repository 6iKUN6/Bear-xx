import { Injectable } from '@nestjs/common';
import type { ApprovalDecision } from '@litter-bear/types/protocol';
import { chatAgentCommonPrompt } from '../../../../prompts';
import {
  ChatContextService,
  type ChatContextBundle,
} from '../../../memory/chat-context.service';
import type {
  LlmMessage,
  LlmTextRequest,
  ResolvedLlmTextRequest,
} from '../../../llm/llm.types';
import { AgentLoopRunnerService } from '../../agent-loop/agent-loop-runner.service';
import type {
  AgentDefinition,
  AgentLoopStreamEvent,
} from '../../agent-loop/agent-loop.types';
import { CapabilityRegistry } from '../../agent-loop/capability/capability.registry';
import { AgentDefinitionService } from '../../../agent/agent-definition.service';
import { CommonChatAgentService } from './common-chat-agent.service';

export interface CommonChatConversationAgentRequest {
  conversationId: string;
  pendingMessageId: string;
  llm?: LlmTextRequest | ResolvedLlmTextRequest;
  /** 数据化智能体 id；缺省用默认 agent */
  agentId?: string | null;
  /** 任务标识；用作 HITL checkpointer 的 thread_id（存在需审批工具时启用中断/恢复） */
  taskId?: string;
  abortSignal?: AbortSignal;
}

export interface PreparedCommonChatAgentRun {
  messages: LlmMessage[];
  systemPrompt?: string;
  tools: unknown[];
  context: ChatContextBundle;
  events: AsyncGenerator<AgentLoopStreamEvent, void, unknown>;
}

@Injectable()
export class CommonChatAgentRunnerService {
  constructor(
    private readonly chatContextService: ChatContextService,
    private readonly commonChatAgentService: CommonChatAgentService,
    private readonly agentLoopRunnerService: AgentLoopRunnerService,
    private readonly capabilityRegistry: CapabilityRegistry,
    private readonly agentDefinitionService: AgentDefinitionService,
  ) {}

  /**
   * 解析文本生成请求
   * @param request 文本生成请求配置
   * @returns 返回已解析完成的模型与生成参数配置
   * @description 对外暴露 agent 使用的模型解析能力，让任务创建阶段不需要直接依赖 LLM 模块。
   */
  resolveTextRequest(
    request?: LlmTextRequest | ResolvedLlmTextRequest,
  ): ResolvedLlmTextRequest {
    return this.commonChatAgentService.resolveTextRequest(request);
  }

  /**
   * 准备会话聊天 agent 运行上下文
   * @param request 会话 agent 请求配置
   * @returns 返回最终消息、系统提示词、可用工具集和结构化事件流
   * @description 加载数据化 agent 定义驱动系统提示词/策略/工具装配；本次实际装载的工具在 agent-loop 内按策略决策解析，此处仅返回可用工具集供 trace。
   */
  async prepareConversationRun(
    request: CommonChatConversationAgentRequest,
  ): Promise<PreparedCommonChatAgentRun> {
    const agentConfig = await this.agentDefinitionService.resolve(
      request.agentId,
    );
    const context = await this.buildContextBundle(request);
    const contextMessages = context.messages;
    const systemPrompt = this.resolveBaseSystemPrompt(agentConfig);
    const llm = this.resolveTextRequest(
      this.pickLlmRequest(request, agentConfig),
    );

    return {
      messages: contextMessages,
      systemPrompt,
      // 可用工具集合，仅用于任务 trace；本次实际装载的工具由 agent-loop 依据策略决策解析。
      tools: this.capabilityRegistry.listTools(),
      context,
      events: this.agentLoopRunnerService.stream({
        messages: contextMessages,
        systemPrompt,
        llm,
        agentConfig,
        threadId: request.taskId,
        abortSignal: request.abortSignal,
      }),
    };
  }

  /**
   * 准备"人工审批恢复"运行上下文
   * @param request 会话 agent 请求 + 人工决定
   * @returns 返回续跑事件流（及供 trace/指标的上下文）
   * @description 恢复不走路由/决策：用同一 thread_id（taskId）与**按 agent 配置装配的**工具 + 审批策略重建 agent，
   * 通过 Command 从中断处续跑（与受限主链路一致，避免用全量工具）。上下文包仅用于完成指标与 trace。
   */
  async resumeConversationRun(
    request: CommonChatConversationAgentRequest & {
      decision: ApprovalDecision;
    },
  ): Promise<PreparedCommonChatAgentRun> {
    const agentConfig = await this.agentDefinitionService.resolve(
      request.agentId,
    );
    const context = await this.buildContextBundle(request);
    const baseSystemPrompt = this.resolveBaseSystemPrompt(agentConfig);
    const llm = this.resolveTextRequest(
      this.pickLlmRequest(request, agentConfig),
    );
    const { tools, approvalToolNames, systemPrompt } =
      this.agentLoopRunnerService.resolveResumeCapabilities({
        messages: context.messages,
        systemPrompt: baseSystemPrompt,
        agentConfig,
      });

    return {
      messages: context.messages,
      systemPrompt,
      tools,
      context,
      events: this.commonChatAgentService.resumeEvents({
        messages: [],
        systemPrompt,
        llm,
        tools,
        threadId: request.taskId,
        approvalToolNames,
        decision: request.decision,
        abortSignal: request.abortSignal,
      }),
    };
  }

  private buildContextBundle(
    request: CommonChatConversationAgentRequest,
  ): Promise<ChatContextBundle> {
    return this.chatContextService.buildContextBundle(
      request.conversationId,
      request.pendingMessageId,
      request.agentId,
    );
  }

  /**
   * 解析基础系统提示词
   * @param agentConfig 智能体定义
   * @returns agent 自定义提示词优先，否则回退内置 .md；均空则 undefined
   * @description 这是 base；技能追加由 agent-loop 的 mergeSystemPrompt 在其后拼接。
   */
  private resolveBaseSystemPrompt(agentConfig: AgentDefinition) {
    const prompt =
      agentConfig.systemPrompt?.trim() || chatAgentCommonPrompt.trim();
    return prompt ? prompt : undefined;
  }

  /**
   * 选择 llm 请求：显式请求优先，否则回退 agent 的 modelPreset
   */
  private pickLlmRequest(
    request: CommonChatConversationAgentRequest,
    agentConfig: AgentDefinition,
  ): LlmTextRequest | ResolvedLlmTextRequest | undefined {
    if (request.llm) {
      return request.llm;
    }
    return agentConfig.modelPreset
      ? { model: { modelId: agentConfig.modelPreset } }
      : undefined;
  }
}
