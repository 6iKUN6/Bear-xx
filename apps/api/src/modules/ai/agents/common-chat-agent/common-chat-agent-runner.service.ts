import { Injectable } from '@nestjs/common';
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
import type { AgentLoopStreamEvent } from '../../agent-loop/agent-loop.types';
import { CapabilityRegistry } from '../../agent-loop/capability/capability.registry';
import { CommonChatAgentService } from './common-chat-agent.service';

export interface CommonChatConversationAgentRequest {
  conversationId: string;
  pendingMessageId: string;
  llm?: LlmTextRequest | ResolvedLlmTextRequest;
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
   * @description 完成上下文读取、系统提示词注入与 agent 执行请求组装；本次实际装载的工具在 agent-loop 内按策略决策解析，此处仅返回可用工具集供 trace。
   */
  async prepareConversationRun(
    request: CommonChatConversationAgentRequest,
  ): Promise<PreparedCommonChatAgentRun> {
    const context = await this.buildContextBundle(request);
    const contextMessages = context.messages;
    const systemPrompt = this.resolveSystemPrompt();
    const llm = this.resolveTextRequest(request.llm);

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
    );
  }

  private resolveSystemPrompt() {
    const prompt = chatAgentCommonPrompt.trim();
    return prompt ? prompt : undefined;
  }
}
