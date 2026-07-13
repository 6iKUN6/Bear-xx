import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../../../llm/llm.service';
import type {
  LlmGenerationConfig,
  LlmMessage,
  LlmModelPreset,
  LlmTextRequest,
  ResolvedLlmTextRequest,
} from '../../../llm/llm.types';
import { CommonChatAgentLoopService } from './common-chat-agent-loop.service';
import type { CommonChatAgentStreamEvent } from './common-chat-agent.types';

export interface CommonChatAgentRequest {
  modelPreset?: string | LlmModelPreset;
  llm?: LlmTextRequest | ResolvedLlmTextRequest;
  messages: LlmMessage[];
  systemPrompt?: string;
  generation?: LlmGenerationConfig;
  tools?: unknown[];
  abortSignal?: AbortSignal;
}

@Injectable()
export class CommonChatAgentService {
  constructor(
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
    private readonly commonChatAgentLoopService: CommonChatAgentLoopService,
  ) {}

  /**
   * 流式执行通用聊天智能体并返回结构化事件
   * @param request 通用聊天智能体请求配置
   * @returns 返回智能体结构化事件流
   * @description 在 agent 层完成消息组装、模型创建、可选工具绑定和 chunk 解析，为后续工具调用链保留独立事件通道。
   */
  streamEvents(
    request: CommonChatAgentRequest,
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const llmRequest = this.buildLlmRequest(request);

    return this.createEventStream(
      request.messages,
      llmRequest,
      request.systemPrompt,
      request.tools,
      request.abortSignal,
    );
  }

  /**
   * 解析文本生成请求
   * @param request 文本生成请求配置
   * @returns 返回已解析完成的模型与生成参数配置
   * @description 对外暴露 agent 使用的模型解析能力，让聊天任务模块不需要直接依赖 LLM 模块。
   */
  resolveTextRequest(
    request?: LlmTextRequest | ResolvedLlmTextRequest,
  ): ResolvedLlmTextRequest {
    return this.llmService.resolveTextRequest(request);
  }

  /**
   * 构建模型请求配置
   * @param request 通用聊天智能体请求配置
   * @returns 返回 llm 模块可直接消费的模型请求配置
   * @description 支持传入模型预设 ID 或完整模型预设对象；若为完整预设对象，则直接构造已解析请求，避免依赖预注册模型列表。
   */
  private buildLlmRequest(
    request: CommonChatAgentRequest,
  ): LlmTextRequest | ResolvedLlmTextRequest {
    if (request.llm) {
      return request.llm;
    }

    if (typeof request.modelPreset === 'string') {
      return {
        model: {
          modelId: request.modelPreset,
        },
        generation: request.generation,
      };
    }

    if (!request.modelPreset) {
      return {
        generation: request.generation,
      };
    }

    return {
      model: {
        id: request.modelPreset.id,
        provider: request.modelPreset.provider,
        platform: request.modelPreset.platform,
        model: request.modelPreset.model,
        apiKey: request.modelPreset.apiKey,
        baseURL: request.modelPreset.baseURL,
      },
      generation: {
        temperature:
          request.generation?.temperature ?? request.modelPreset.temperature,
        maxOutputTokens:
          request.generation?.maxOutputTokens ??
          request.modelPreset.maxOutputTokens,
        topP: request.generation?.topP ?? request.modelPreset.topP,
      },
    };
  }

  /**
   * 创建智能体事件流
   * @param messages 聊天消息列表
   * @param llmRequest 模型请求配置
   * @param tools 可选工具列表
   * @param abortSignal 中断信号
   * @returns 返回智能体结构化事件异步迭代器
   * @description 在 agent 层消费模型原始 chunk，并拆分成文本增量和工具调用增量事件。
   */
  private async *createEventStream(
    messages: LlmMessage[],
    llmRequest: LlmTextRequest | ResolvedLlmTextRequest,
    systemPrompt?: string,
    tools?: unknown[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const resolvedRequest = this.llmService.resolveTextRequest(llmRequest);
    const chatModel = this.llmService.createChatModel(resolvedRequest);

    this.debugLog('agent.common_chat.request', {
      model: this.toSafeModelLog(resolvedRequest),
      messageCount: messages.length,
      generation: resolvedRequest.generation,
      toolCount: tools?.length ?? 0,
      hasSystemPrompt: Boolean(systemPrompt),
      hasAbortSignal: Boolean(abortSignal),
    });

    for await (const event of this.commonChatAgentLoopService.stream({
      model: chatModel,
      messages,
      systemPrompt,
      tools,
      abortSignal,
    })) {
      yield event;
    }
  }

  private toSafeModelLog(request: ResolvedLlmTextRequest) {
    return {
      id: request.model.id,
      provider: request.model.provider,
      platform: request.model.platform,
      model: request.model.model,
      baseURL: this.toSafeBaseUrl(request.model.baseURL),
      hasApiKey: Boolean(request.model.apiKey),
    };
  }

  private toSafeBaseUrl(baseURL: string | undefined) {
    if (!baseURL) {
      return undefined;
    }

    try {
      const url = new URL(baseURL);
      return url.origin;
    } catch {
      return '[invalid-url]';
    }
  }

  private formatLog(event: string, payload: Record<string, unknown>) {
    return JSON.stringify({
      event,
      ...payload,
    });
  }

  private debugLog(event: string, payload: Record<string, unknown>) {
    if (!this.isDebugEnabled()) {
      return;
    }

    Logger.log(this.formatLog(event, payload), CommonChatAgentService.name);
  }

  private isDebugEnabled() {
    return this.readBooleanConfig('LLM_DEBUG');
  }

  private readBooleanConfig(key: string) {
    const value = this.configService.get<string>(key);
    return value === 'true' || value === '1';
  }
}
