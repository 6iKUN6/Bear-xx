import { Injectable } from '@nestjs/common';
import { LlmService } from '../../../llm/llm.service';
import type {
  LlmGenerationConfig,
  LlmMessage,
  LlmModelPreset,
  LlmTextRequest,
  ResolvedLlmTextRequest,
} from '../../../llm/llm.types';

export interface CommonChatAgentRequest {
  modelPreset: string | LlmModelPreset;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  systemPrompt?: string;
  generation?: LlmGenerationConfig;
  abortSignal?: AbortSignal;
}

@Injectable()
export class CommonChatAgentService {
  constructor(private readonly llmService: LlmService) {}

  /**
   * 流式执行通用聊天智能体
   * @param request 通用聊天智能体请求配置
   * @returns 返回模型输出的文本分片异步迭代器
   * @description 根据传入的模型预设、系统提示词和对话消息构造统一聊天上下文，并委托 llm 模块直接返回流式文本结果。
   */
  stream(
    request: CommonChatAgentRequest,
  ): AsyncGenerator<string, void, unknown> {
    const messages = this.buildMessages(request);
    const llmRequest = this.buildLlmRequest(request);

    return this.createStream(messages, llmRequest, request.abortSignal);
  }

  /**
   * 构建聊天消息列表
   * @param request 通用聊天智能体请求配置
   * @returns 返回可直接传给 llm 模块的聊天消息列表
   * @description 在普通用户/助手消息前按需插入系统提示词，形成一次完整的聊天上下文。
   */
  private buildMessages(request: CommonChatAgentRequest): LlmMessage[] {
    const messages: LlmMessage[] = [];

    if (request.systemPrompt) {
      messages.push({
        role: 'system',
        content: request.systemPrompt,
      });
    }

    messages.push(...request.messages);
    return messages;
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
    if (typeof request.modelPreset === 'string') {
      return {
        model: {
          modelId: request.modelPreset,
        },
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
   * 创建聊天输出流
   * @param messages 聊天消息列表
   * @param llmRequest 模型请求配置
   * @param abortSignal 中断信号
   * @returns 返回模型文本分片异步迭代器
   * @description 对 llm 模块返回的流式结果做一层显式包装，保持智能体服务的返回类型稳定且清晰。
   */
  private async *createStream(
    messages: LlmMessage[],
    llmRequest: LlmTextRequest | ResolvedLlmTextRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<string, void, unknown> {
    for await (const chunk of this.llmService.streamChatText(
      messages,
      llmRequest,
      {
        abortSignal,
      },
    )) {
      yield chunk;
    }
  }
}
