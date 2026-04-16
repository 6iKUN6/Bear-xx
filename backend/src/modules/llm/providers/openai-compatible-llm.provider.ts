import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import type { ResolvedLlmTextRequest } from '../llm.types';

@Injectable()
export class OpenAiCompatibleLlmProvider {
  constructor(private readonly configService: ConfigService) {}

  /**
   * 创建聊天模型实例
   * @param request 已解析的文本生成请求配置
   * @returns 返回可执行流式生成的 LangChain ChatOpenAI 实例
   * @description 使用统一的 OpenAI 兼容协议参数创建模型实例，支持通过 baseURL 和 apiKey 对接不同供应商。
   */
  createChatModel(request: ResolvedLlmTextRequest): BaseChatModel {
    const { model, generation } = request;

    return new ChatOpenAI({
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
}
