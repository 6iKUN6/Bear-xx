import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LanguageModel } from 'ai';
import { LLM_PROVIDER_ADAPTERS } from './llm.constants';
import type { LlmProviderAdapter } from './interfaces/llm-provider.interface';
import type {
  LlmMessage,
  LlmModelConfig,
  LlmProviderName,
  LlmStreamOptions,
} from './llm.types';

@Injectable()
export class LlmService {
  constructor(
    @Inject(LLM_PROVIDER_ADAPTERS)
    private readonly providers: LlmProviderAdapter[],
    private readonly configService: ConfigService,
  ) {}

  /**
   * 获取聊天模型实例
   * @param config 模型配置覆盖项
   * @returns 返回可用于生成文本的语言模型实例
   * @description 合并环境变量和调用方传入配置后，选择对应 provider 并返回聊天模型对象。
   */
  getChatModel(config?: Partial<LlmModelConfig>): LanguageModel {
    const resolvedConfig = this.resolveConfig(config);
    return this.getProvider(resolvedConfig.provider).getChatModel(
      resolvedConfig,
    );
  }

  /**
   * 流式生成文本
   * @param messages 模型消息列表
   * @param config 模型配置覆盖项
   * @param options 流式生成附加参数
   * @returns 返回文本分片异步迭代器
   * @description 根据解析后的 provider 和模型配置发起流式生成请求，并逐段返回模型输出。
   */
  streamText(
    messages: LlmMessage[],
    config?: Partial<LlmModelConfig>,
    options?: LlmStreamOptions,
  ): AsyncGenerator<string> {
    const resolvedConfig = this.resolveConfig(config);
    return this.getProvider(resolvedConfig.provider).streamText(
      messages,
      resolvedConfig,
      options,
    );
  }

  /**
   * 获取 provider 适配器
   * @param name provider 名称
   * @returns 返回对应的 provider 适配器实现
   * @description 从已注册的 provider 适配器列表中查找目标实现；若不存在则抛出异常。
   */
  private getProvider(name: LlmProviderName) {
    const provider = this.providers.find((item) => item.name === name);
    if (!provider) {
      throw new Error(`Unsupported LLM provider: ${name}`);
    }

    return provider;
  }

  /**
   * 解析模型配置
   * @param config 模型配置覆盖项
   * @returns 返回最终生效的模型配置
   * @description 合并调用方传入配置与环境变量默认值，得到完整的 provider、model 和连接配置。
   */
  private resolveConfig(config?: Partial<LlmModelConfig>): LlmModelConfig {
    const provider =
      config?.provider ??
      this.configService.get<LlmProviderName>('LLM_PROVIDER') ??
      'openai';
    const model =
      config?.model ??
      this.configService.get<string>('LLM_MODEL') ??
      this.configService.get<string>('AI_MODEL') ??
      'gpt-4o-mini';

    return {
      provider,
      model,
      apiKey: config?.apiKey,
      baseURL: config?.baseURL,
    };
  }
}
