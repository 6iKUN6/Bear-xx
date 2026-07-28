import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { BUILTIN_LLM_MODEL_PRESETS } from './llm.presets';
import {
  ANTHROPIC_PLATFORM,
  AnthropicChatModel,
  createAnthropicModelPreset,
} from './providers/anthropic';
import {
  DEEPSEEK_PLATFORM,
  DeepseekChatModel,
  createDeepseekModelPreset,
} from './providers/deepseek';
import {
  DOUBAO_PLATFORM,
  DoubaoChatModel,
  createDoubaoModelPreset,
} from './providers/doubao';
import {
  KIMI_PLATFORM,
  KimiChatModel,
  createKimiModelPreset,
} from './providers/kimi';
import { createOpenAiCompatibleModelPreset } from './providers/openai-compatible-model-preset';
import type {
  LlmModelPreset,
  LlmModelSelector,
  LlmProviderName,
  LlmTextRequest,
  ResolvedLlmModelConfig,
  ResolvedLlmTextRequest,
} from './llm.types';

@Injectable()
export class LlmModelRegistryService implements OnModuleInit {
  private readonly logger = new Logger(LlmModelRegistryService.name);
  /** 静态层：内置 + env 自动 + LLM_MODEL_PRESETS（构造期一次算好，不变） */
  private readonly environmentPresets: LlmModelPreset[];
  private readonly configuredPresets: LlmModelPreset[];
  /** 生效列表 = 静态层 + DB 层，去重后缓存；DB 变更时 invalidate 重建 */
  private modelPresets: LlmModelPreset[];

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.environmentPresets = this.loadEnvironmentModelPresets();
    const configuredValue =
      this.configService.get<string>('LLM_MODEL_PRESETS')?.trim() ?? '';
    this.configuredPresets = configuredValue
      ? this.parseConfiguredModelPresets(configuredValue)
      : [];
    // 构造期先用静态层（DB 尚未加载）；onModuleInit 再并入 DB 预设。
    this.modelPresets = this.mergePresets([]);
  }

  /** 启动时加载 DB 预设并入生效列表 */
  async onModuleInit(): Promise<void> {
    await this.invalidate();
  }

  /**
   * 重新从 DB 加载模型预设并重建生效列表
   * @description ModelPreset 写操作后调用。DB 不可用时静默降级为仅静态层。
   */
  async invalidate(): Promise<void> {
    const dbPresets = await this.loadDbModelPresets();
    this.modelPresets = this.mergePresets(dbPresets);
  }

  /**
   * 从 DB 读取模型预设并映射为 LlmModelPreset（apiKey 恒为 undefined，运行时从 env 兜底）
   */
  private async loadDbModelPresets(): Promise<LlmModelPreset[]> {
    try {
      const rows = await this.prisma.modelPreset.findMany({
        where: { enabled: true },
      });
      return rows.map((row) => ({
        id: row.presetId,
        provider: this.ensureSupportedProvider(row.provider),
        platform: row.platform,
        model: row.model,
        // apiKey 永不落库；toResolvedModelConfig 按 platform 从 env 兜底。
        apiKey: undefined,
        baseURL: row.baseURL ?? undefined,
        temperature: row.temperature ?? undefined,
        maxOutputTokens: row.maxOutputTokens ?? undefined,
        topP: row.topP ?? undefined,
        enabled: row.enabled,
      }));
    } catch (error) {
      this.logger.warn(
        `加载 DB 模型预设失败，降级为静态预设：${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * 合并各层预设为生效列表
   * @description 优先级低→高：内置 < env 自动 < DB < LLM_MODEL_PRESETS（后者覆盖前者，同 id 去重）。
   * DB 优先于 env（admin 管理的预设覆盖自动生成），JSON 显式配置仍为最高兜底。
   */
  private mergePresets(dbPresets: LlmModelPreset[]): LlmModelPreset[] {
    const modelPresetMap = new Map<string, LlmModelPreset>();
    for (const preset of [
      ...BUILTIN_LLM_MODEL_PRESETS,
      ...this.environmentPresets,
      ...dbPresets,
      ...this.configuredPresets,
    ]) {
      modelPresetMap.set(preset.id, preset);
    }
    return [...modelPresetMap.values()];
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
   * 加载环境变量模型预设
   * @returns 返回根据环境变量生成的模型预设列表
   * @description 读取 OpenAI、Anthropic、DeepSeek、Kimi、豆包等供应商的专用环境变量，自动生成对应的模型预设，减少在 .env 中手写 JSON 的成本。
   */
  private loadEnvironmentModelPresets(): LlmModelPreset[] {
    const presets: LlmModelPreset[] = [];
    const openAiApiKey = this.readConfigString('OPENAI_API_KEY');
    const anthropicApiKey = this.readConfigString('ANTHROPIC_API_KEY');
    const deepseekApiKey = this.readConfigString('DEEPSEEK_API_KEY');
    const kimiApiKey = this.readConfigString('KIMI_API_KEY');
    const doubaoApiKey = this.readConfigString('DOUBAO_API_KEY');

    if (openAiApiKey) {
      const model =
        this.readConfigString('OPENAI_MODEL') ??
        this.readConfigString('LLM_MODEL') ??
        'gpt-4o-mini';
      presets.push(
        createOpenAiCompatibleModelPreset({
          platform: 'openai',
          model,
          apiKey: openAiApiKey,
          baseURL: this.readConfigString('OPENAI_BASE_URL'),
        }),
      );
    }

    if (anthropicApiKey) {
      presets.push(
        createAnthropicModelPreset({
          model:
            this.readConfigString('ANTHROPIC_MODEL') ??
            AnthropicChatModel.CLAUDE_SONNET_4_5,
          apiKey: anthropicApiKey,
          baseURL: this.readConfigString('ANTHROPIC_BASE_URL'),
        }),
      );
    }

    if (deepseekApiKey) {
      presets.push(
        createDeepseekModelPreset({
          model:
            this.readConfigString('DEEPSEEK_MODEL') ??
            DeepseekChatModel.DEEPSEEK_CHAT,
          apiKey: deepseekApiKey,
          baseURL: this.readConfigString('DEEPSEEK_BASE_URL'),
        }),
      );
    }

    if (kimiApiKey) {
      presets.push(
        createKimiModelPreset({
          model: this.readConfigString('KIMI_MODEL') ?? KimiChatModel.KIMI_K2,
          apiKey: kimiApiKey,
          baseURL: this.readConfigString('KIMI_BASE_URL'),
        }),
      );
    }

    if (doubaoApiKey) {
      presets.push(
        createDoubaoModelPreset({
          model:
            this.readConfigString('DOUBAO_MODEL') ??
            DoubaoChatModel.DOUBAO_SEED_1_6,
          apiKey: doubaoApiKey,
          baseURL: this.readConfigString('DOUBAO_BASE_URL'),
        }),
      );
    }

    return presets;
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

    const configuredModel = this.readConfigString('LLM_MODEL');
    if (configuredModel) {
      const matchedPreset = this.listAvailableModels().find(
        (item) => item.model === configuredModel,
      );
      if (matchedPreset) {
        return matchedPreset;
      }
    }

    const configuredPreset = this.listAvailableModels().find(
      (item) => item.apiKey,
    );
    if (configuredPreset) {
      return configuredPreset;
    }

    return this.listAvailableModels().find(
      (item) => item.provider === 'openai' && item.model === 'gpt-4o-mini',
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
    const provider = this.resolveAdHocProvider(selector);
    const platform = selector?.platform ?? provider;
    const model = selector?.model ?? this.resolveDefaultModel(provider);

    if (!model) {
      throw new BadRequestException('未指定可用的模型名称');
    }

    return {
      id: `${platform}:${model}`,
      provider,
      platform,
      model,
      apiKey: this.resolvePlatformApiKey(platform, provider),
      baseURL: this.resolvePlatformBaseUrl(platform, provider),
    };
  }

  /**
   * 读取平台默认 API Key
   * @param platform 模型平台名称
   * @returns 返回平台对应的 API Key；若未配置则返回 undefined
   * @description 为临时模型选择场景提供平台级默认鉴权信息，避免调用方在每次请求里重复传递 API Key。
   */
  private resolvePlatformApiKey(
    platform: string,
    provider: LlmProviderName,
  ): string | undefined {
    switch (platform) {
      case ANTHROPIC_PLATFORM:
        return this.readConfigString('ANTHROPIC_API_KEY');
      case DEEPSEEK_PLATFORM:
        return this.readConfigString('DEEPSEEK_API_KEY');
      case KIMI_PLATFORM:
        return this.readConfigString('KIMI_API_KEY');
      case DOUBAO_PLATFORM:
        return this.readConfigString('DOUBAO_API_KEY');
      case 'openai':
        return this.readConfigString('OPENAI_API_KEY');
      default:
        return provider === 'anthropic'
          ? this.readConfigString('ANTHROPIC_API_KEY')
          : this.readConfigString('OPENAI_API_KEY');
    }
  }

  /**
   * 读取平台默认 Base URL
   * @param platform 模型平台名称
   * @returns 返回平台对应的 Base URL；若未配置则返回 undefined
   * @description 为临时模型选择场景提供平台级默认网关地址，兼容不同 OpenAI 协议供应商的地址差异。
   */
  private resolvePlatformBaseUrl(
    platform: string,
    provider: LlmProviderName,
  ): string | undefined {
    switch (platform) {
      case ANTHROPIC_PLATFORM:
        return this.readConfigString('ANTHROPIC_BASE_URL');
      case DEEPSEEK_PLATFORM:
        return this.readConfigString('DEEPSEEK_BASE_URL');
      case KIMI_PLATFORM:
        return this.readConfigString('KIMI_BASE_URL');
      case DOUBAO_PLATFORM:
        return this.readConfigString('DOUBAO_BASE_URL');
      case 'openai':
        return this.readConfigString('OPENAI_BASE_URL');
      default:
        return provider === 'anthropic'
          ? this.readConfigString('ANTHROPIC_BASE_URL')
          : this.readConfigString('OPENAI_BASE_URL');
    }
  }

  /**
   * 解析临时模型 provider
   * @param selector 模型选择条件
   * @returns 返回临时模型应使用的 provider
   * @description 请求未显式传 provider 时，根据 Anthropic 平台推断 provider，其他平台默认按 OpenAI 兼容协议处理。
   */
  private resolveAdHocProvider(selector?: LlmModelSelector): LlmProviderName {
    if (selector?.provider) {
      return this.ensureSupportedProvider(selector.provider);
    }

    if (selector?.platform === ANTHROPIC_PLATFORM) {
      return 'anthropic';
    }

    return 'openai';
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
      // DB 预设不带密钥/地址：按 platform 从 env 兜底（密钥永不落库的核心边界）。
      // env 自动预设已带 apiKey，?? 保留其原值。
      apiKey:
        preset.apiKey ??
        this.resolvePlatformApiKey(preset.platform, preset.provider),
      baseURL:
        preset.baseURL ??
        this.resolvePlatformBaseUrl(preset.platform, preset.provider),
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
    if (provider !== 'openai' && provider !== 'anthropic') {
      throw new BadRequestException(`不支持的 LLM Provider: ${provider}`);
    }

    return provider;
  }

  /**
   * 解析 provider 默认模型名
   * @param provider provider 名称
   * @returns 返回当前 provider 对应的默认模型名
   * @description 临时模型配置未显式指定 model 时，按 provider 读取对应环境变量，避免 Anthropic 请求落到 OpenAI 默认模型。
   */
  private resolveDefaultModel(provider: LlmProviderName): string | undefined {
    if (provider === 'anthropic') {
      return (
        this.readConfigString('ANTHROPIC_MODEL') ??
        this.readConfigString('LLM_MODEL') ??
        AnthropicChatModel.CLAUDE_SONNET_4_5
      );
    }

    return (
      this.readConfigString('LLM_MODEL') ??
      this.readConfigString('OPENAI_MODEL') ??
      'gpt-4o-mini'
    );
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

  /**
   * 读取环境变量字符串
   * @param key 环境变量名称
   * @returns 返回去除首尾空白后的字符串；若为空则返回 undefined
   * @description 用于统一读取 ConfigService 中的字符串配置，避免在各处重复处理 trim 和空字符串判断。
   */
  private readConfigString(key: string): string | undefined {
    const value = this.configService.get<string>(key);
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmedValue = value.trim();
    return trimmedValue === '' ? undefined : trimmedValue;
  }
}
