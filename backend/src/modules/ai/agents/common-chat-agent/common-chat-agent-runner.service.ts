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
   * @returns 返回最终消息、系统提示词、工具和结构化事件流
   * @description 在同一层完成上下文读取、系统提示词注入、工具选择和 agent 执行请求组装。
   */
  async prepareConversationRun(
    request: CommonChatConversationAgentRequest,
  ): Promise<PreparedCommonChatAgentRun> {
    const context = await this.buildContextBundle(request);
    const contextMessages = context.messages;
    const systemPrompt = this.resolveSystemPrompt();
    const tools = this.buildTools(request);
    const llm = this.resolveTextRequest(request.llm);

    return {
      messages: contextMessages,
      systemPrompt,
      tools,
      context,
      events: this.agentLoopRunnerService.stream({
        messages: contextMessages,
        systemPrompt,
        llm,
        tools,
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

  private buildTools(_request: CommonChatConversationAgentRequest): unknown[] {
    return [];
  }
}
