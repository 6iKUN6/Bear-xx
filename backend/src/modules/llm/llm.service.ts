import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { BUILTIN_LLM_MODEL_PRESETS } from './llm.presets';
import type {
  LlmMessage,
  LlmModelPreset,
  LlmModelSelector,
  LlmProviderName,
  LlmTextRequest,
  LlmStreamOptions,
  ResolvedLlmModelConfig,
  ResolvedLlmTextRequest,
} from './llm.types';

@Injectable()
export class LlmService {
  private readonly modelPresets: LlmModelPreset[];

  constructor(private readonly configService: ConfigService) {
    this.modelPresets = this.loadModelPresets();
  }

  /**
   * 流式生成聊天文本
   * @param messages 聊天消息列表
   * @param request 文本生成请求配置
   * @param options 流式运行时附加参数
   * @returns 返回文本分片异步迭代器
   * @description 解析模型选择配置后，使用 LangChain ChatOpenAI 流式生成文本，并仅向上层暴露纯文本分片。
   */
  async *streamChatText(
    messages: LlmMessage[],
    request?: LlmTextRequest | ResolvedLlmTextRequest,
    options?: LlmStreamOptions,
  ): AsyncGenerator<string> {
    const resolvedRequest = this.resolveTextRequest(request);
    const chatModel = this.createChatModel(resolvedRequest);
    const langChainMessages = this.toLangChainMessages(messages);
    const stream = await chatModel.stream(langChainMessages, {
      signal: options?.abortSignal,
    });

    for await (const chunk of stream) {
      const delta = this.readChunkText(chunk.content);
      if (delta) {
        yield delta;
      }
    }
  }

  /**
   * 解析文本生成请求
   * @param request 文本生成请求配置
   * @returns 返回已解析完成的模型与生成参数配置
   * @description 统一处理 modelId、provider、platform、model 等选择条件，并合并预设默认参数与调用方覆盖参数。
   */
  resolveTextRequest(
    request?: LlmTextRequest | ResolvedLlmTextRequest,
  ): ResolvedLlmTextRequest {
    if (this.isResolvedTextRequest(request)) {
      return request;
    }

    const preset = this.resolvePreset(request?.model);
    const resolvedModel = preset
      ? this.toResolvedModelConfig(preset)
      : this.resolveAdHocModel(request?.model);

    return {
      model: resolvedModel,
      generation: {
        temperature: request?.generation?.temperature ?? preset?.temperature,
        maxOutputTokens:
          request?.generation?.maxOutputTokens ?? preset?.maxOutputTokens,
        topP: request?.generation?.topP ?? preset?.topP,
      },
    };
  }

  /**
   * 获取可用模型列表
   * @returns 返回当前可用的模型预设列表
   * @description 汇总内置模型预设与环境变量扩展配置，并过滤掉显式禁用的模型。
   */
  listAvailableModels(): LlmModelPreset[] {
    return this.modelPresets.filter((item) => item.enabled !== false);
  }

  /**
   * 创建 LangChain 聊天模型
   * @param request 已解析的文本生成请求配置
   * @returns 返回可直接执行流式生成的 LangChain ChatOpenAI 实例
   * @description 将统一的模型配置转换为 LangChain 所需参数，集中处理 apiKey、baseURL、temperature 与 maxTokens 等字段。
   */
  private createChatModel(request: ResolvedLlmTextRequest) {
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

  /**
   * 加载模型预设列表
   * @returns 返回最终生效的模型预设列表
   * @description 合并内置模型预设与环境变量中的扩展预设；当存在相同 id 时，后者会覆盖前者。
   */
  private loadModelPresets(): LlmModelPreset[] {
    const configuredValue =
      this.configService.get<string>('LLM_MODEL_PRESETS')?.trim() ?? '';
    const configuredPresets = configuredValue
      ? this.parseConfiguredModelPresets(configuredValue)
      : [];

    const modelPresetMap = new Map<string, LlmModelPreset>();
    for (const preset of [...BUILTIN_LLM_MODEL_PRESETS, ...configuredPresets]) {
      modelPresetMap.set(preset.id, preset);
    }

    return [...modelPresetMap.values()];
  }

  /**
   * 解析环境变量中的模型预设
   * @param rawValue 环境变量原始字符串
   * @returns 返回解析后的模型预设列表
   * @description 将 JSON 字符串形式的模型预设配置解析为结构化对象，并校验必要字段。
   */
  private parseConfiguredModelPresets(rawValue: string): LlmModelPreset[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      throw new BadRequestException('LLM_MODEL_PRESETS 必须是合法的 JSON 数组');
    }

    if (!Array.isArray(parsed)) {
      throw new BadRequestException('LLM_MODEL_PRESETS 必须是 JSON 数组');
    }

    return parsed.map((item, index) =>
      this.parseSingleModelPreset(item, index),
    );
  }

  /**
   * 解析单个模型预设
   * @param value 单个预设原始值
   * @param index 当前预设在数组中的位置
   * @returns 返回合法的模型预设对象
   * @description 校验模型预设中的 id、provider、platform、model 等关键字段，并转换为内部统一结构。
   */
  private parseSingleModelPreset(
    value: unknown,
    index: number,
  ): LlmModelPreset {
    if (!value || typeof value !== 'object') {
      throw new BadRequestException(`LLM_MODEL_PRESETS[${index}] 必须是对象`);
    }

    const preset = value as Record<string, unknown>;
    const id = this.readRequiredString(
      preset.id,
      `LLM_MODEL_PRESETS[${index}].id`,
    );
    const provider = this.ensureSupportedProvider(
      this.readRequiredString(
        preset.provider,
        `LLM_MODEL_PRESETS[${index}].provider`,
      ),
    );
    const platform = this.readRequiredString(
      preset.platform,
      `LLM_MODEL_PRESETS[${index}].platform`,
    );
    const model = this.readRequiredString(
      preset.model,
      `LLM_MODEL_PRESETS[${index}].model`,
    );

    return {
      id,
      provider,
      platform,
      model,
      apiKey: this.readOptionalString(preset.apiKey),
      baseURL: this.readOptionalString(preset.baseURL),
      enabled: this.readOptionalBoolean(preset.enabled),
      temperature: this.readOptionalNumber(preset.temperature),
      maxOutputTokens: this.readOptionalNumber(preset.maxOutputTokens),
      topP: this.readOptionalNumber(preset.topP),
    };
  }

  /**
   * 解析模型预设
   * @param selector 模型选择条件
   * @returns 返回匹配到的模型预设；若无法匹配则返回 undefined
   * @description 优先按 modelId 精确匹配，其次按 provider、platform、model 组合过滤；若存在多条匹配则优先使用默认模型预设。
   */
  private resolvePreset(
    selector?: LlmModelSelector,
  ): LlmModelPreset | undefined {
    const models = this.listAvailableModels();

    if (selector?.modelId) {
      const preset = models.find((item) => item.id === selector.modelId);
      if (!preset) {
        throw new BadRequestException(`未找到模型预设: ${selector.modelId}`);
      }

      return preset;
    }

    const hasSelector = Boolean(
      selector?.provider || selector?.platform || selector?.model,
    );
    if (!hasSelector) {
      return this.getDefaultModelPreset();
    }

    const nonEmptySelector = selector as LlmModelSelector;
    const matched = models.filter((item) => {
      if (
        nonEmptySelector.provider &&
        item.provider !== nonEmptySelector.provider
      ) {
        return false;
      }
      if (
        nonEmptySelector.platform &&
        item.platform !== nonEmptySelector.platform
      ) {
        return false;
      }
      if (nonEmptySelector.model && item.model !== nonEmptySelector.model) {
        return false;
      }
      return true;
    });

    if (matched.length === 1) {
      return matched[0];
    }

    if (matched.length > 1) {
      const defaultPreset = this.getDefaultModelPreset();
      if (defaultPreset) {
        const preferred = matched.find((item) => item.id === defaultPreset.id);
        if (preferred) {
          return preferred;
        }
      }

      throw new BadRequestException('模型选择不唯一，请补充 modelId 或 model');
    }

    return undefined;
  }

  /**
   * 获取默认模型预设
   * @returns 返回默认模型预设；若未命中则返回 undefined
   * @description 优先读取 LLM_DEFAULT_MODEL_ID 对应的模型预设；若未配置，则尝试使用环境变量中的 provider/model 匹配已注册预设。
   */
  private getDefaultModelPreset(): LlmModelPreset | undefined {
    const defaultModelId =
      this.configService.get<string>('LLM_DEFAULT_MODEL_ID')?.trim() ?? '';
    if (defaultModelId) {
      const preset = this.listAvailableModels().find(
        (item) => item.id === defaultModelId,
      );
      if (!preset) {
        throw new BadRequestException(
          `LLM_DEFAULT_MODEL_ID 未命中任何模型预设: ${defaultModelId}`,
        );
      }

      return preset;
    }

    const provider =
      this.configService.get<LlmProviderName>('LLM_PROVIDER') ?? 'openai';
    const model =
      this.configService.get<string>('LLM_MODEL') ??
      this.configService.get<string>('AI_MODEL') ??
      'gpt-4o-mini';

    return this.listAvailableModels().find(
      (item) => item.provider === provider && item.model === model,
    );
  }

  /**
   * 解析临时模型配置
   * @param selector 模型选择条件
   * @returns 返回解析后的模型配置
   * @description 当请求未命中任何模型预设时，退回到 provider/model 级别的直接解析；若请求未显式提供，则使用系统默认配置。
   */
  private resolveAdHocModel(
    selector?: LlmModelSelector,
  ): ResolvedLlmModelConfig {
    const configuredProvider =
      selector?.provider ??
      this.configService.get<LlmProviderName>('LLM_PROVIDER') ??
      'openai';
    const provider = this.ensureSupportedProvider(configuredProvider);
    const model =
      selector?.model ??
      this.configService.get<string>('LLM_MODEL') ??
      this.configService.get<string>('AI_MODEL') ??
      'gpt-4o-mini';
    const platform = selector?.platform ?? provider;

    if (!model) {
      throw new BadRequestException('未指定可用的模型名称');
    }

    return {
      id: `${platform}:${model}`,
      provider,
      platform,
      model,
      baseURL: this.configService.get<string>('OPENAI_BASE_URL'),
    };
  }

  /**
   * 转换为已解析模型配置
   * @param preset 模型预设
   * @returns 返回 provider 可直接消费的模型配置
   * @description 将模型预设对象裁剪并转换为执行层统一使用的模型配置结构。
   */
  private toResolvedModelConfig(
    preset: LlmModelPreset,
  ): ResolvedLlmModelConfig {
    return {
      id: preset.id,
      provider: preset.provider,
      platform: preset.platform,
      model: preset.model,
      apiKey: preset.apiKey,
      baseURL: preset.baseURL,
    };
  }

  /**
   * 判断是否为已解析请求
   * @param request 文本生成请求配置
   * @returns 返回布尔值，true 表示已经完成解析
   * @description 通过检查请求中是否已包含解析后的模型 id、platform 与 provider 字段，识别是否需要再次解析。
   */
  private isResolvedTextRequest(
    request?: LlmTextRequest | ResolvedLlmTextRequest,
  ): request is ResolvedLlmTextRequest {
    const model = request?.model;
    if (!request || !model) {
      return false;
    }

    return 'id' in model && 'platform' in model && 'provider' in model;
  }

  /**
   * 校验 provider 是否受支持
   * @param provider provider 名称
   * @returns 返回受支持的 provider 名称
   * @description 确认传入 provider 已在系统中注册，否则抛出参数错误。
   */
  private ensureSupportedProvider(provider: string): LlmProviderName {
    if (provider !== 'openai') {
      throw new BadRequestException(`不支持的 LLM Provider: ${provider}`);
    }

    return provider;
  }

  /**
   * 转换为 LangChain 消息列表
   * @param messages 通用聊天消息列表
   * @returns 返回 LangChain BaseMessage 数组
   * @description 将系统内部统一的消息结构转换为 LangChain 消费的消息对象，避免在业务层直接耦合 LangChain 消息类型。
   */
  private toLangChainMessages(
    messages: LlmMessage[],
  ): Array<AIMessage | HumanMessage | SystemMessage> {
    return messages.map((message) => {
      if (message.role === 'system') {
        return new SystemMessage(message.content);
      }

      if (message.role === 'assistant') {
        return new AIMessage(message.content);
      }

      return new HumanMessage(message.content);
    });
  }

  /**
   * 读取流式分片中的文本内容
   * @param content LangChain 返回的消息内容
   * @returns 返回当前分片中的纯文本内容
   * @description 兼容字符串和内容块数组两种返回结构，仅提取可直接用于 SSE delta 推送的文本部分。
   */
  private readChunkText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }

        const record = item as Record<string, unknown>;
        if (record.type !== 'text' || typeof record.text !== 'string') {
          return '';
        }

        return record.text;
      })
      .join('');
  }

  /**
   * 读取必填字符串字段
   * @param value 原始字段值
   * @param fieldName 字段名
   * @returns 返回非空字符串
   * @description 用于从原始配置对象中提取必填字符串字段；若字段缺失或为空，则抛出参数错误。
   */
  private readRequiredString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new BadRequestException(`${fieldName} 必须是非空字符串`);
    }

    return value.trim();
  }

  /**
   * 读取可选字符串字段
   * @param value 原始字段值
   * @returns 返回字符串或 undefined
   * @description 用于从原始配置对象中提取可选字符串字段；若字段不是字符串则返回 undefined。
   */
  private readOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmedValue = value.trim();
    return trimmedValue === '' ? undefined : trimmedValue;
  }

  /**
   * 读取可选布尔字段
   * @param value 原始字段值
   * @returns 返回布尔值或 undefined
   * @description 用于从原始配置对象中提取可选布尔字段；若字段未提供则返回 undefined。
   */
  private readOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  /**
   * 读取可选数值字段
   * @param value 原始字段值
   * @returns 返回数值或 undefined
   * @description 用于从原始配置对象中提取可选数值字段；若字段不是有限数字则返回 undefined。
   */
  private readOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }
}
