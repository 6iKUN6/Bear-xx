import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAICompletions } from '@langchain/openai';
import type { ResolvedLlmTextRequest } from '../llm.types';

@Injectable()
export class LlmChatModelFactory {
  constructor(private readonly configService: ConfigService) {}

  /**
   * 创建聊天模型实例
   * @param request 已解析的文本生成请求配置
   * @returns 返回可执行流式生成的 LangChain ChatModel 实例
   * @description 根据 provider 创建对应 SDK 的模型实例，避免业务层直接耦合具体模型供应商。
   */
  createChatModel(request: ResolvedLlmTextRequest): BaseChatModel {
    if (request.model.provider === 'anthropic') {
      return this.createAnthropicChatModel(request);
    }

    if (request.model.provider === 'openai') {
      return this.createOpenAiCompatibleChatModel(request);
    }

    throw new BadRequestException(
      `未找到对应的 LLM Provider: ${String(request.model.provider)}`,
    );
  }

  /**
   * 创建 OpenAI 兼容聊天模型实例
   * @param request 已解析的文本生成请求配置
   * @returns 返回 LangChain ChatOpenAICompletions 实例
   * @description 通过 baseURL 与 apiKey 支持 OpenAI、DeepSeek、Kimi、豆包等 OpenAI 兼容协议平台；工具调用优先使用 Chat Completions 协议，避免 Responses API 在兼容服务中出现 tool call output 与 call_id 不匹配。
   */
  private createOpenAiCompatibleChatModel(
    request: ResolvedLlmTextRequest,
  ): BaseChatModel {
    const { model, generation } = request;

    return new ChatOpenAICompletions({
      model: model.model,
      apiKey: model.apiKey ?? this.configService.get<string>('OPENAI_API_KEY'),
      temperature: generation.temperature,
      maxTokens: generation.maxOutputTokens,
      topP: generation.topP,
      configuration: {
        baseURL:
          model.baseURL ?? this.configService.get<string>('OPENAI_BASE_URL'),
      },
    });
  }

  /**
   * 创建 Anthropic 聊天模型实例
   * @param request 已解析的文本生成请求配置
   * @returns 返回 LangChain ChatAnthropic 实例
   * @description 使用 Anthropic SDK 参数创建 Claude 模型；baseURL 会映射为 ChatAnthropic 的 anthropicApiUrl。
   */
  private createAnthropicChatModel(
    request: ResolvedLlmTextRequest,
  ): BaseChatModel {
    const { model, generation } = request;

    return new ChatAnthropic({
      model: model.model,
      apiKey:
        model.apiKey ?? this.configService.get<string>('ANTHROPIC_API_KEY'),
      anthropicApiUrl:
        model.baseURL ?? this.configService.get<string>('ANTHROPIC_BASE_URL'),
      temperature: generation.temperature,
      maxTokens: generation.maxOutputTokens,
      topP: generation.topP,
    });
  }
}
