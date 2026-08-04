import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { LlmModelRegistryService } from './llm-model-registry.service';
import { LlmChatModelFactory } from './providers/chat-model.factory';
import { classifyLlmError } from './llm-error';
import type {
  LlmImageEditRequest,
  LlmImageRequest,
  LlmImageResult,
  LlmMessage,
  LlmTextRequest,
  LlmStreamOptions,
  LlmGenerateOptions,
  ResolvedLlmTextRequest,
  LlmTokenUsageMetrics,
} from './llm.types';

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
    const langChainMessages = this.toLangChainMessages(messages);
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
    const langChainMessages = this.toLangChainMessages(messages);
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
   * @param cachedInputTokens 命中的输入缓存 token 数
   * @returns 返回统一 token 用量指标
   * @description 在模型 provider 没有返回真实 usage 时，为单轮 trace 和前端反馈提供稳定的估算指标。
   */
  buildEstimatedTokenUsage(
    inputMessages: LlmMessage[],
    outputText: string,
    cachedInputTokens = 0,
  ): LlmTokenUsageMetrics {
    const inputTokens = this.estimateMessagesTokenCount(inputMessages);
    const outputTokens = this.estimateTextTokenCount(outputText);

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedInputTokens,
      estimated: true,
    };
  }

  /**
   * 创建聊天模型实例
   * @param request 已解析的文本生成请求配置
   * @returns 返回可执行流式生成的 LangChain 聊天模型实例
   * @description 委托统一模型工厂根据 provider 创建具体 LangChain ChatModel 实例。
   */
  createChatModel(request: ResolvedLlmTextRequest) {
    return this.chatModelFactory.createChatModel(request);
  }

  /**
   * 转换为 LangChain 消息列表
   * @param messages 通用聊天消息列表
   * @returns 返回 LangChain BaseMessage 数组
   * @description 将系统内部统一的消息结构转换为 LangChain 消费的消息对象，避免在业务层直接耦合 LangChain 消息类型。
   */
  private toLangChainMessages(messages: LlmMessage[]) {
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
   * @description 走 OpenAI 兼容的 /v1/images/generations 端点（gpt-image 系列 /
   * dall-e / 兼容中转站通用）。模型配置独立于聊天模型，来自 IMAGE_GEN_* env：
   * 未配置时抛 503（生图链路留白可随时补 key 启用，不影响其它功能）。
   */
  async generateImage(request: LlmImageRequest): Promise<LlmImageResult> {
    const { baseURL, apiKey, model } = this.requireImageConfig(request.model);

    this.debugLog('llm.image.request', {
      model,
      promptLength: request.prompt.length,
      size: request.size,
    });

    const response = await fetch(`${baseURL}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt: request.prompt,
        n: 1,
        ...(request.size ? { size: request.size } : {}),
      }),
      signal: request.abortSignal ?? AbortSignal.timeout(120000),
    });

    return this.parseImageResponse(response);
  }

  /**
   * 参考图生图（图生图/改图）
   * @param request 参考图 + prompt 的编辑请求
   * @returns 返回图片 URL 或 base64 与润色后的 prompt
   * @description 走 OpenAI 兼容的 /v1/images/edits 端点（gpt-image 系列原生
   * 支持多参考图高保真输入）。edits 是 multipart/form-data：单图用 image 字段，
   * 多图按官方约定用 image[] 重复字段；Content-Type 由 FormData 自带 boundary。
   */
  async editImage(request: LlmImageEditRequest): Promise<LlmImageResult> {
    const { baseURL, apiKey, model } = this.requireImageConfig(request.model);

    this.debugLog('llm.image.edit.request', {
      model,
      promptLength: request.prompt.length,
      imageCount: request.images.length,
      size: request.size,
    });

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

  /** 生图模型配置（独立于聊天模型）；未配置抛 503，链路留白可随时补 key 启用 */
  private requireImageConfig(modelOverride?: string) {
    const baseURL = this.configService.get<string>('IMAGE_GEN_BASE_URL');
    const apiKey = this.configService.get<string>('IMAGE_GEN_API_KEY');
    const model =
      modelOverride ?? this.configService.get<string>('IMAGE_GEN_MODEL');

    if (!baseURL || !apiKey || !model) {
      throw new ServiceUnavailableException(
        '生图模型未配置：请在 env 中填写 IMAGE_GEN_BASE_URL / IMAGE_GEN_API_KEY / IMAGE_GEN_MODEL',
      );
    }

    // 归一化：容忍带不带尾部 /v1 两种填法（代码统一自己拼 /v1/...，
    // env 里多带一个 /v1 会打出 /v1/v1/... 的 404）
    return {
      baseURL: baseURL.replace(/\/+$/, '').replace(/\/v1$/i, ''),
      apiKey,
      model,
    };
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
