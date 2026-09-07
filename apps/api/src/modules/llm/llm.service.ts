import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ZodType } from 'zod';
import { LlmModelRegistryService } from './llm-model-registry.service';
import { LlmChatModelFactory } from './providers/chat-model.factory';
import { classifyLlmError } from './llm-error';
import { parseJsonFromText } from '../../common/utils/json-extract';
import type {
  LlmImageEditRequest,
  LlmImageRequest,
  LlmImageResult,
  LlmMessage,
  LlmTextRequest,
  LlmStreamOptions,
  LlmGenerateOptions,
  LlmStructuredOptions,
  ResolvedLlmTextRequest,
  LlmTokenUsageMetrics,
  LlmVisionRequestTransform,
} from './llm.types';
import { toLangChainMessages } from '../ai/agents/common-chat-agent/llm-message.mapper';

/** 生图 provider 类型：openai 兼容（gpt-image / dall-e / 中转站）| 豆包 Seedream（Ark） */
type ImageProviderKind = 'openai' | 'seedream';

/**
 * 工具层尺寸枚举 → Seedream 合法尺寸的映射
 * @description Seedream 要求 width*height ∈ [2560x1440=3686400, 4096x4096=16777216]，
 * 而工具层沿用的 1024x1024 / 1024x1536 / 1536x1024 全部低于下限（会报
 * "至少 3,686,400 像素"）。这里按相同的画幅语义（方图/竖图/横图）映射到官方推荐尺寸，
 * 保持工具 schema 对模型不变。
 */
const SEEDREAM_SIZE_MAP: Record<string, string> = {
  '1024x1024': '2048x2048', // 方图
  '1024x1536': '1664x2496', // 竖图
  '1536x1024': '2496x1664', // 横图
};

/** Seedream 默认尺寸（方图，4194304 像素，位于合法区间内） */
const SEEDREAM_DEFAULT_SIZE = '2048x2048';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly modelRegistry: LlmModelRegistryService,
    private readonly chatModelFactory: LlmChatModelFactory,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 流式生成聊天文本
   * @param messages 聊天消息列表
   * @param request 文本生成请求配置
   * @param options 流式运行时附加参数
   * @returns 返回文本分片异步迭代器
   * @description 解析模型选择配置后，使用对应 LangChain ChatModel 流式生成文本，并仅向上层暴露纯文本分片。
   */
  async *streamChatText(
    messages: LlmMessage[],
    request?: LlmTextRequest | ResolvedLlmTextRequest,
    options?: LlmStreamOptions,
  ): AsyncGenerator<string> {
    const resolvedRequest = this.modelRegistry.resolveTextRequest(request);
    const chatModel = this.createChatModel(resolvedRequest);
    const langChainMessages = toLangChainMessages(messages);
    const startedAt = Date.now();
    let rawChunkCount = 0;
    let parsedChunkCount = 0;
    let skippedChunkCount = 0;
    let totalParsedLength = 0;

    this.debugLog('llm.request', {
      model: this.toSafeModelLog(resolvedRequest),
      messageCount: messages.length,
      generation: resolvedRequest.generation,
      hasAbortSignal: Boolean(options?.abortSignal),
    });

    try {
      const stream = await chatModel.stream(langChainMessages, {
        signal: options?.abortSignal,
      });

      for await (const chunk of stream) {
        rawChunkCount++;
        const delta = this.readChunkText(chunk.content);

        this.debugLog('llm.chunk', {
          chunkIndex: rawChunkCount,
          contentType: this.describeChunkContent(chunk.content),
          parsedTextLength: delta.length,
          rawPreview: this.getChunkPreview(chunk.content),
        });

        if (delta) {
          parsedChunkCount++;
          totalParsedLength += delta.length;
          yield delta;
        } else {
          skippedChunkCount++;
        }
      }

      if (rawChunkCount === 0) {
        this.logger.warn(
          this.formatLog('llm.empty_stream', {
            model: this.toSafeModelLog(resolvedRequest),
            durationMs: Date.now() - startedAt,
          }),
        );
      } else if (parsedChunkCount === 0) {
        this.logger.warn(
          this.formatLog('llm.unparsed_stream', {
            model: this.toSafeModelLog(resolvedRequest),
            rawChunkCount,
            skippedChunkCount,
            durationMs: Date.now() - startedAt,
          }),
        );
      }

      this.debugLog('llm.completed', {
        model: this.toSafeModelLog(resolvedRequest),
        rawChunkCount,
        parsedChunkCount,
        skippedChunkCount,
        totalParsedLength,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.logger.error(
        this.formatLog('llm.failed', {
          model: this.toSafeModelLog(resolvedRequest),
          rawChunkCount,
          parsedChunkCount,
          skippedChunkCount,
          totalParsedLength,
          durationMs: Date.now() - startedAt,
          error: classifyLlmError(error),
        }),
      );
      throw error;
    }
  }

  /**
   * 非流式生成聊天文本
   * @param messages 聊天消息列表
   * @param request 文本生成请求配置
   * @param options 非流式运行时附加参数
   * @returns 返回完整文本内容
   * @description 适用于摘要、工具内部生成等不需要 SSE 增量输出的后台任务，避免调用方为了拼接完整结果而消费流式接口。
   */
  async generateChatText(
    messages: LlmMessage[],
    request?: LlmTextRequest | ResolvedLlmTextRequest,
    options?: LlmGenerateOptions,
  ): Promise<string> {
    const resolvedRequest = this.modelRegistry.resolveTextRequest(request);
    const chatModel = this.createChatModel(resolvedRequest);
    const langChainMessages = toLangChainMessages(messages);
    const startedAt = Date.now();

    this.debugLog('llm.generate.request', {
      model: this.toSafeModelLog(resolvedRequest),
      messageCount: messages.length,
      generation: resolvedRequest.generation,
      hasAbortSignal: Boolean(options?.abortSignal),
    });

    try {
      const response = await chatModel.invoke(langChainMessages, {
        signal: options?.abortSignal,
      });
      const content = this.readChunkText(response.content).trim();

      if (!content) {
        this.logger.warn(
          this.formatLog('llm.generate.empty', {
            model: this.toSafeModelLog(resolvedRequest),
            durationMs: Date.now() - startedAt,
          }),
        );
      }

      this.debugLog('llm.generate.completed', {
        model: this.toSafeModelLog(resolvedRequest),
        contentLength: content.length,
        durationMs: Date.now() - startedAt,
      });

      return content;
    } catch (error) {
      this.logger.error(
        this.formatLog('llm.generate.failed', {
          model: this.toSafeModelLog(resolvedRequest),
          durationMs: Date.now() - startedAt,
          error: classifyLlmError(error),
        }),
      );
      throw error;
    }
  }

  /**
   * 结构化生成：按 schema 约束模型输出
   * @param messages 聊天消息列表
   * @param schema zod schema，既用于约束模型也用于校验结果
   * @param options 模型选择 / 生成参数 / schema 名称 / abortSignal
   * @returns 返回通过校验的结构化结果；不可用或校验失败时返回 null（由调用方降级）
   * @description 优先走 provider 原生结构化输出（OpenAI 兼容的 json_schema、Anthropic 的
   * tool 模式，由 LangChain withStructuredOutput 抹平差异）；provider 不支持或调用失败时，
   * 降级为「提示词约束 + 从杂文里提取 JSON」，**两条路径都用同一 schema 做校验**——
   * 这是相比裸 generateChatText 的核心收益：非法输出在此收敛，调用方只需处理 null。
   */
  async generateStructured<T>(
    messages: LlmMessage[],
    schema: ZodType<T>,
    options?: LlmStructuredOptions,
  ): Promise<T | null> {
    const resolvedRequest = this.modelRegistry.resolveTextRequest(
      options?.request,
    );
    const langChainMessages = toLangChainMessages(messages);
    const startedAt = Date.now();
    const schemaName = options?.schemaName ?? 'structured_output';

    this.debugLog('llm.structured.request', {
      model: this.toSafeModelLog(resolvedRequest),
      schemaName,
      messageCount: messages.length,
    });

    try {
      const chatModel = this.createChatModel(resolvedRequest);
      const structured = chatModel.withStructuredOutput(schema, {
        name: schemaName,
      });
      const result = (await structured.invoke(langChainMessages, {
        signal: options?.abortSignal,
      })) as unknown;

      const parsed = schema.safeParse(result);
      if (parsed.success) {
        this.debugLog('llm.structured.completed', {
          model: this.toSafeModelLog(resolvedRequest),
          schemaName,
          durationMs: Date.now() - startedAt,
        });
        return parsed.data;
      }

      this.logger.warn(
        this.formatLog('llm.structured.invalid', {
          model: this.toSafeModelLog(resolvedRequest),
          schemaName,
        }),
      );
    } catch (error) {
      // provider 不支持 json_schema、或本次调用失败：转提示词降级路径
      this.logger.warn(
        this.formatLog('llm.structured.unavailable', {
          model: this.toSafeModelLog(resolvedRequest),
          schemaName,
          error: classifyLlmError(error),
        }),
      );
    }

    return this.generateStructuredByPrompt(
      messages,
      schema,
      resolvedRequest,
      options,
    );
  }

  /**
   * 结构化生成的降级路径：提示词约束 + 提取 JSON + schema 校验
   * @returns 返回通过校验的结果；仍失败则 null
   * @description 供不支持原生结构化输出的 provider 使用。相比历史实现的差别在于
   * 结果仍过 schema.safeParse，字段缺失/类型不符不会被当成有效决策放行。
   */
  private async generateStructuredByPrompt<T>(
    messages: LlmMessage[],
    schema: ZodType<T>,
    resolvedRequest: ResolvedLlmTextRequest,
    options?: LlmStructuredOptions,
  ): Promise<T | null> {
    try {
      const raw = await this.generateChatText(
        [
          ...messages,
          {
            role: 'system',
            content:
              '只输出符合要求的 JSON 对象，禁止输出解释、Markdown 代码块或任何额外文本。',
          },
        ],
        resolvedRequest,
        { abortSignal: options?.abortSignal },
      );

      const value = parseJsonFromText(raw);
      if (value === undefined) {
        this.logger.warn('llm.structured.fallback_unparsable');
        return null;
      }

      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        this.logger.warn('llm.structured.fallback_invalid');
        return null;
      }
      return parsed.data;
    } catch (error) {
      this.logger.warn(
        `llm.structured.fallback_failed: ${(error as Error).message}`,
      );
      return null;
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
    return this.modelRegistry.resolveTextRequest(request);
  }

  /**
   * 获取可用模型列表
   * @returns 返回当前可用的模型预设列表
   * @description 汇总内置模型预设与环境变量扩展配置，并过滤掉显式禁用的模型。
   */
  listAvailableModels() {
    return this.modelRegistry.listAvailableModels();
  }

  /**
   * 估算聊天消息的 token 数
   * @param messages 聊天消息列表
   * @returns 返回估算 token 数
   * @description 当前 provider 流式响应未稳定返回 usage 时，使用字符长度进行保守估算，并在 metrics 中标记 estimated。
   */
  estimateMessagesTokenCount(messages: LlmMessage[]) {
    return this.estimateTextTokenCount(
      messages.map((message) => message.content).join('\n'),
    );
  }

  /**
   * 估算文本 token 数
   * @param text 文本内容
   * @returns 返回估算 token 数
   * @description 使用中英混合场景的粗略估算：中文字符按 1 token 左右，英文按约 4 字符 1 token；用于 UI 反馈而非计费。
   */
  estimateTextTokenCount(text: string) {
    if (!text) {
      return 0;
    }

    const cjkCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
    const nonWhitespaceCount = text.replace(/\s/g, '').length;
    const nonCjkCount = Math.max(0, nonWhitespaceCount - cjkCount);
    return Math.max(1, Math.ceil(cjkCount + nonCjkCount / 4));
  }

  /**
   * 构建估算 token 用量
   * @param inputMessages 输入消息列表
   * @param outputText 输出文本
   * @returns 返回统一 token 用量指标
   * @description 在模型回调没有采集到真实 usage 时，为旧链路提供保守估算；
   * 供应商 Prompt Cache 的 token 数无法由本地推断，因此固定为 0。
   */
  buildEstimatedTokenUsage(
    inputMessages: LlmMessage[],
    outputText: string,
  ): LlmTokenUsageMetrics {
    const inputTokens = this.estimateMessagesTokenCount(inputMessages);
    const outputTokens = this.estimateTextTokenCount(outputText);

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedInputTokens: 0,
      estimated: true,
    };
  }

  /**
   * 创建聊天模型实例
   * @param request 已解析的文本生成请求配置
   * @returns 返回可执行流式生成的 LangChain 聊天模型实例
   * @description 委托统一模型工厂根据 provider 创建具体 LangChain ChatModel 实例。
   */
  createChatModel(
    request: ResolvedLlmTextRequest,
    visionTransform?: LlmVisionRequestTransform,
  ) {
    return this.chatModelFactory.createChatModel(request, visionTransform);
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

  private describeChunkContent(content: unknown) {
    if (typeof content === 'string') {
      return { type: 'string', length: content.length };
    }

    if (Array.isArray(content)) {
      return {
        type: 'array',
        length: content.length,
        blockTypes: content.map((item) => this.describeContentBlockType(item)),
      };
    }

    return { type: typeof content };
  }

  private describeContentBlockType(item: unknown) {
    if (!item || typeof item !== 'object') {
      return typeof item;
    }

    const type = (item as Record<string, unknown>).type;
    return typeof type === 'string' && type ? type : 'unknown';
  }

  private getChunkPreview(content: unknown) {
    if (!this.isChunkDebugEnabled()) {
      return undefined;
    }

    return this.safePreview(content);
  }

  private safePreview(value: unknown) {
    const previewLength =
      Number(
        this.configService.get<string>('LLM_DEBUG_CHUNK_PREVIEW_LENGTH'),
      ) || 1000;

    try {
      return JSON.stringify(value).slice(0, previewLength);
    } catch {
      return String(value).slice(0, previewLength);
    }
  }

  private debugLog(event: string, payload: Record<string, unknown>) {
    if (!this.isDebugEnabled()) {
      return;
    }

    this.logger.log(this.formatLog(event, payload));
  }

  private formatLog(event: string, payload: Record<string, unknown>) {
    return JSON.stringify({
      event,
      ...payload,
    });
  }

  private isDebugEnabled() {
    return this.readBooleanConfig('LLM_DEBUG');
  }

  private isChunkDebugEnabled() {
    return this.readBooleanConfig('LLM_DEBUG_CHUNKS');
  }

  private readBooleanConfig(key: string) {
    const value = this.configService.get<string>(key);
    return value === 'true' || value === '1';
  }

  /**
   * 调用生图模型生成图片
   * @param request 生图请求（prompt/size/model）
   * @returns 返回图片 URL 或 base64（不同 provider 二选一）与润色后的 prompt
   * @description 按激活 provider 分派：openai 兼容走 /v1/images/generations（gpt-image
   * 系列 / dall-e / 中转站），Seedream 走 Ark 的 /images/generations。配置独立于聊天模型，
   * 来自 IMAGE_GEN_* env：未配置激活 provider 时抛 503（留白可随时补 key 启用）。
   */
  async generateImage(request: LlmImageRequest): Promise<LlmImageResult> {
    const { kind, baseURL, apiKey, model } = this.resolveImageProvider(
      request.model,
    );

    this.debugLog('llm.image.request', {
      provider: kind,
      model,
      promptLength: request.prompt.length,
      size: request.size,
    });

    // Seedream 端点无 /v1 前缀（base 已含 /api/v3）；openai 兼容统一拼 /v1。
    const endpoint =
      kind === 'seedream'
        ? `${baseURL}/images/generations`
        : `${baseURL}/v1/images/generations`;
    // Seedream 有像素下限，尺寸需按画幅语义映射；openai 分支原样透传。
    const size =
      kind === 'seedream' ? this.toSeedreamSize(request.size) : request.size;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt: request.prompt,
        n: 1,
        ...(size ? { size } : {}),
      }),
      signal: request.abortSignal ?? AbortSignal.timeout(120000),
    });

    return this.parseImageResponse(response);
  }

  /**
   * 参考图生图（图生图/改图）
   * @param request 参考图 + prompt 的编辑请求
   * @returns 返回图片 URL 或 base64 与润色后的 prompt
   * @description 按激活 provider 分派：Seedream 文生图/图生图同一 /images/generations
   * 端点，参考图以 base64 data URI 放 image 字段（1 张给字符串、多张给数组）；
   * openai 兼容走独立的 multipart /v1/images/edits（单图 image、多图 image[]）。
   */
  async editImage(request: LlmImageEditRequest): Promise<LlmImageResult> {
    const { kind, baseURL, apiKey, model } = this.resolveImageProvider(
      request.model,
    );

    this.debugLog('llm.image.edit.request', {
      provider: kind,
      model,
      promptLength: request.prompt.length,
      imageCount: request.images.length,
      size: request.size,
    });

    if (kind === 'seedream') {
      const images = request.images.map((image) =>
        this.toImageDataUri(image.data, image.mimeType),
      );
      const response = await fetch(`${baseURL}/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt: request.prompt,
          n: 1,
          image: images.length > 1 ? images : images[0],
          size: this.toSeedreamSize(request.size),
        }),
        signal: request.abortSignal ?? AbortSignal.timeout(180000),
      });
      return this.parseImageResponse(response);
    }

    const form = new FormData();
    form.append('model', model);
    form.append('prompt', request.prompt);
    form.append('n', '1');
    if (request.size) {
      form.append('size', request.size);
    }
    const fieldName = request.images.length > 1 ? 'image[]' : 'image';
    request.images.forEach((image, index) => {
      form.append(
        fieldName,
        new Blob([new Uint8Array(image.data)], {
          type: image.mimeType ?? 'image/png',
        }),
        `reference-${index}.png`,
      );
    });

    const response = await fetch(`${baseURL}/v1/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: request.abortSignal ?? AbortSignal.timeout(180000),
    });

    return this.parseImageResponse(response);
  }

  /**
   * 解析激活的生图 provider 配置（独立于聊天模型）
   * @param modelOverride 覆盖默认模型名（来自 per-call 请求）
   * @returns provider 类型 + 归一化 baseURL + apiKey + model
   * @description 由 IMAGE_GEN_PROVIDER 选择（缺省 seedream）。未配置对应三元组抛 503，
   * 报错点名缺哪套 key，链路留白可随时补 key 启用，不影响其它功能。
   */
  private resolveImageProvider(modelOverride?: string): {
    kind: ImageProviderKind;
    baseURL: string;
    apiKey: string;
    model: string;
  } {
    const provider = (
      this.configService.get<string>('IMAGE_GEN_PROVIDER') ?? 'seedream'
    )
      .trim()
      .toLowerCase();

    if (provider === 'seedream') {
      const baseURL = this.configService.get<string>(
        'IMAGE_GEN_SEEDREAM_BASE_URL',
      );
      const apiKey = this.configService.get<string>(
        'IMAGE_GEN_SEEDREAM_API_KEY',
      );
      const model =
        modelOverride ??
        this.configService.get<string>('IMAGE_GEN_SEEDREAM_MODEL');
      if (!baseURL || !apiKey || !model) {
        throw new ServiceUnavailableException(
          '生图模型未配置：请在 env 中填写 IMAGE_GEN_SEEDREAM_BASE_URL / IMAGE_GEN_SEEDREAM_API_KEY / IMAGE_GEN_SEEDREAM_MODEL（或改 IMAGE_GEN_PROVIDER=openai 切换）',
        );
      }
      // Ark base 形如 .../api/v3，仅去尾部斜杠（不能删 /v1，那是 openai 分支的活）
      return {
        kind: 'seedream',
        baseURL: baseURL.replace(/\/+$/, ''),
        apiKey,
        model,
      };
    }

    const baseURL = this.configService.get<string>('IMAGE_GEN_BASE_URL');
    const apiKey = this.configService.get<string>('IMAGE_GEN_API_KEY');
    const model =
      modelOverride ?? this.configService.get<string>('IMAGE_GEN_MODEL');
    if (!baseURL || !apiKey || !model) {
      throw new ServiceUnavailableException(
        '生图模型未配置：请在 env 中填写 IMAGE_GEN_BASE_URL / IMAGE_GEN_API_KEY / IMAGE_GEN_MODEL（或改 IMAGE_GEN_PROVIDER=seedream 切换）',
      );
    }

    // 归一化：容忍带不带尾部 /v1 两种填法（代码统一自己拼 /v1/...，
    // env 里多带一个 /v1 会打出 /v1/v1/... 的 404）
    return {
      kind: 'openai',
      baseURL: baseURL.replace(/\/+$/, '').replace(/\/v1$/i, ''),
      apiKey,
      model,
    };
  }

  /**
   * 工具层尺寸 → Seedream 合法尺寸
   * @param size 工具层枚举尺寸（可空）
   * @returns 返回 Seedream 可接受的尺寸串
   * @description 未传或不在映射表内的值一律兜底为默认方图，而不是原样透传——
   * 透传低于像素下限的尺寸会被 Ark 直接拒绝（"至少 3,686,400 像素"）。
   */
  private toSeedreamSize(size?: string): string {
    if (!size) {
      return SEEDREAM_DEFAULT_SIZE;
    }
    return SEEDREAM_SIZE_MAP[size] ?? SEEDREAM_DEFAULT_SIZE;
  }

  /**
   * 参考图转 base64 data URI（Seedream image 字段格式）
   * @description Ark 约定 data:image/<格式>;base64,<...>，且 <格式> 需小写。
   */
  private toImageDataUri(data: Buffer, mimeType?: string): string {
    const mime = (mimeType ?? 'image/png').toLowerCase();
    return `data:${mime};base64,${data.toString('base64')}`;
  }

  /** 解析 generations/edits 共同的响应形状（url 或 b64_json 二选一） */
  private async parseImageResponse(
    response: Response,
  ): Promise<LlmImageResult> {
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `生图请求失败(${response.status})：${detail.slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{
        url?: string;
        b64_json?: string;
        revised_prompt?: string;
      }>;
    };
    const image = payload.data?.[0];
    if (!image?.url && !image?.b64_json) {
      throw new Error('生图响应缺少图片数据');
    }

    return {
      url: image.url,
      b64: image.b64_json,
      revisedPrompt: image.revised_prompt,
    };
  }
}
