import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LLMResult } from '@langchain/core/outputs';
import { ChatAnthropic, type ChatAnthropicInput } from '@langchain/anthropic';
import {
  ChatGoogleGenerativeAI,
  type GoogleGenerativeAIChatInput,
} from '@langchain/google-genai';
import { ChatOpenAIResponses } from '@langchain/openai';
import type {
  LlmVisionRequestTransform,
  ResolvedLlmTextRequest,
} from '../llm.types';
import { findModelReasoningCapability } from '../model-reasoning.catalog';
import {
  recordModelCallEnd,
  recordModelCallStart,
} from '../../ai/telemetry/model-call-context';
import { ReasoningContextChatOpenAICompletions } from './reasoning-context-chat-openai';

/**
 * 模型调用用量采集回调
 * @description 在每次模型调用开始和结束时将输入、输出与供应商 usage 写入当前任务上下文。
 * agent 路径与直连路径都经模型构造，此回调是唯一交汇点，能覆盖 ReAct 内部多次往返。
 */
const MODEL_CALL_USAGE_CALLBACK = {
  handleChatModelStart: (
    _model: unknown,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ) => recordModelCallStart(runId, messages, extraParams),
  handleLLMEnd: (output: LLMResult, runId: string) =>
    recordModelCallEnd(runId, output),
};

/** LLM 调用健壮性默认值：重试次数与单次请求超时 */
const DEFAULT_LLM_MAX_RETRIES = 3;
const DEFAULT_LLM_TIMEOUT_MS = 30000;

/** 递归复制 JSON 请求体，并只替换与目标 URL 完全相等的字符串。 */
function replaceExactString(
  value: unknown,
  source: string,
  replacement: string,
): unknown {
  if (value === source) {
    return replacement;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceExactString(item, source, replacement));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      replaceExactString(item, source, replacement),
    ]),
  );
}

@Injectable()
export class LlmChatModelFactory {
  constructor(private readonly configService: ConfigService) {}

  /**
   * 解析 LLM 调用健壮性参数
   * @returns 返回重试次数与单次请求超时（毫秒）
   * @description 从环境变量读取 LLM_MAX_RETRIES / LLM_TIMEOUT_MS，非法或缺省时回退到默认值。
   * maxRetries 由 LangChain AsyncCaller 消费，对 429/5xx/超时做指数退避；timeout 用于避免请求无限挂起。
   */
  private resolveResilienceOptions(): {
    maxRetries: number;
    timeoutMs: number;
  } {
    return {
      maxRetries: this.readPositiveInt(
        this.configService.get<string>('LLM_MAX_RETRIES'),
        DEFAULT_LLM_MAX_RETRIES,
      ),
      timeoutMs: this.readPositiveInt(
        this.configService.get<string>('LLM_TIMEOUT_MS'),
        DEFAULT_LLM_TIMEOUT_MS,
      ),
    };
  }

  /**
   * 读取非负整数配置
   * @param raw 原始字符串配置值
   * @param fallback 缺省或非法时的回退值
   * @returns 返回解析后的整数；非法输入回退到默认值
   */
  private readPositiveInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      return fallback;
    }
    return Math.floor(value);
  }

  /**
   * 创建聊天模型实例
   * @param request 已解析的文本生成请求配置
   * @returns 返回可执行流式生成的 LangChain ChatModel 实例
   * @description 根据 provider 创建对应 SDK 的模型实例，避免业务层直接耦合具体模型供应商。
   */
  createChatModel(
    request: ResolvedLlmTextRequest,
    visionTransform?: LlmVisionRequestTransform,
  ): BaseChatModel {
    switch (request.model.upstreamFormat) {
      case 'anthropic_messages':
        return this.createAnthropicChatModel(request);
      case 'openai_responses':
        return this.createOpenAiResponsesChatModel(request);
      case 'openai_chat_completions':
        return this.createOpenAiCompatibleChatModel(request, visionTransform);
      case 'gemini_generate_content':
        return this.createGeminiChatModel(request);
      default:
        throw new BadRequestException(
          `未支持的上游格式: ${String(request.model.upstreamFormat)}`,
        );
    }
  }

  /**
   * 创建走 Responses 协议的 OpenAI 模型实例
   * @param request 已解析的文本生成请求配置
   * @returns 返回 LangChain ChatOpenAIResponses 实例
   * @description Responses 与 Chat Completions 的工具调用 id 语义不同（`fc_` 对 `call_`），
   * 两者混用会在回填工具结果时报 400 —— 这正是 docs/agent-loop-evolution.md 记录的那次事故。
   * 因此格式必须由预设显式选定并端到端保持一致，而不是在链路中途切换。
   * 兼容网关是否真的实现了 Responses 的工具往返，由连通性探针实测判定，不在此假设。
   */
  private createOpenAiResponsesChatModel(
    request: ResolvedLlmTextRequest,
  ): BaseChatModel {
    const { model, generation } = request;
    const { maxRetries, timeoutMs } = this.resolveResilienceOptions();

    return new ChatOpenAIResponses({
      model: model.model,
      apiKey: model.apiKey,
      temperature: generation.temperature,
      maxTokens: generation.maxOutputTokens,
      topP: generation.topP,
      maxRetries,
      timeout: timeoutMs,
      callbacks: [MODEL_CALL_USAGE_CALLBACK],
      configuration: { baseURL: model.baseURL },
    });
  }

  /**
   * 创建 OpenAI 兼容聊天模型实例
   * @param request 已解析的文本生成请求配置
   * @returns 返回 LangChain ChatOpenAICompletions 实例
   * @description 覆盖 OpenAI 与一切 OpenAI 兼容网关（DeepSeek / Kimi / 豆包 / 自建中转站）；这是默认且最稳的格式，工具调用 id 为 `call_` 语义。
   */
  private createOpenAiCompatibleChatModel(
    request: ResolvedLlmTextRequest,
    visionTransform?: LlmVisionRequestTransform,
  ): BaseChatModel {
    const { model, generation } = request;
    const { maxRetries, timeoutMs } = this.resolveResilienceOptions();

    return new ReasoningContextChatOpenAICompletions({
      model: model.model,
      apiKey: model.apiKey,
      temperature: generation.temperature,
      maxTokens: generation.maxOutputTokens,
      topP: generation.topP,
      maxRetries,
      timeout: timeoutMs,
      callbacks: [MODEL_CALL_USAGE_CALLBACK],
      modelKwargs: this.createOpenAiCompatibleReasoningKwargs(request),
      configuration: {
        baseURL: model.baseURL,
        ...(visionTransform
          ? { fetch: this.createVisionTransformFetch(visionTransform) }
          : {}),
      },
    });
  }

  /**
   * 创建只改写当前图片 URL 的请求发送器。
   * @param transform 公网 URL 与对应 Data URI
   * @returns 返回兼容 OpenAI SDK 的 fetch
   * @description LangGraph checkpoint 只保存不含 Base64 的公网 URL；K3 发包前才在内存中
   * 精确替换同值字符串。工具多轮与 SDK 重试复用同一 Data URI，不重复下载对象。
   */
  private createVisionTransformFetch(
    transform: LlmVisionRequestTransform,
  ): typeof fetch {
    return async (input, init) => {
      if (typeof init?.body !== 'string') {
        return fetch(input, init);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(init.body);
      } catch {
        return fetch(input, init);
      }
      return fetch(input, {
        ...init,
        body: JSON.stringify(
          replaceExactString(parsed, transform.sourceUrl, transform.dataUri),
        ),
      });
    };
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
    const { maxRetries, timeoutMs } = this.resolveResilienceOptions();

    const reasoning = this.createAnthropicReasoningParams(request);
    return new ChatAnthropic({
      model: model.model,
      apiKey: model.apiKey,
      anthropicApiUrl: model.baseURL,
      temperature: generation.temperature,
      maxTokens: generation.maxOutputTokens,
      topP: generation.topP,
      maxRetries,
      callbacks: [MODEL_CALL_USAGE_CALLBACK],
      ...reasoning,
      // Anthropic SDK 的超时通过 clientOptions 透传（无顶层 timeout 参数）。
      clientOptions: { timeout: timeoutMs },
    });
  }

  /** 创建 Google Gemini 原生 generateContent 模型。 */
  private createGeminiChatModel(
    request: ResolvedLlmTextRequest,
  ): BaseChatModel {
    const { model, generation } = request;
    const { maxRetries } = this.resolveResilienceOptions();
    const chatModel = new ChatGoogleGenerativeAI({
      model: model.model,
      apiKey: model.apiKey,
      baseUrl: model.baseURL,
      temperature: generation.temperature,
      maxOutputTokens: generation.maxOutputTokens,
      topP: generation.topP,
      maxRetries,
      callbacks: [MODEL_CALL_USAGE_CALLBACK],
      thinkingConfig: this.createGeminiThinkingConfig(request),
    });

    if (request.reasoning?.effort === 'minimal') {
      // @langchain/google-genai 2.2 的类型比 Gemini 3 API 少 MINIMAL，但 invocationParams
      // 会原样透传该官方值。把差异收敛在 provider 工厂，业务层仍只使用统一强度闭集。
      Object.assign(chatModel, {
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      });
    }
    return chatModel;
  }

  /** 将统一选择映射为受控的 OpenAI 兼容扩展字段。 */
  private createOpenAiCompatibleReasoningKwargs(
    request: ResolvedLlmTextRequest,
  ): Record<string, unknown> | undefined {
    const capability = findModelReasoningCapability(
      request.model.platform,
      request.model.upstreamFormat,
      request.model.model,
    );
    const mapping = capability?.requestMapping;
    if (!mapping || mapping.kind !== 'openai-compatible') {
      return undefined;
    }

    const result: Record<string, unknown> = {};
    const selection = request.reasoning;
    if (mapping.activation === 'thinking.type' && selection?.activation) {
      result.thinking = { type: selection.activation };
    }
    if (mapping.activation === 'enable_thinking' && selection?.activation) {
      result.enable_thinking = selection.activation !== 'disabled';
    }
    if (mapping.effort && selection?.effort) {
      result.reasoning_effort = selection.effort;
    }
    if (mapping.budget && typeof selection?.budgetTokens === 'number') {
      result.thinking_budget = selection.budgetTokens;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /** 将统一选择映射为 Anthropic thinking/outputConfig。 */
  private createAnthropicReasoningParams(
    request: ResolvedLlmTextRequest,
  ): Partial<Pick<ChatAnthropicInput, 'thinking' | 'outputConfig'>> {
    const capability = findModelReasoningCapability(
      request.model.platform,
      request.model.upstreamFormat,
      request.model.model,
    );
    const mapping = capability?.requestMapping;
    const selection = request.reasoning;
    if (!mapping || mapping.kind !== 'anthropic') {
      return {};
    }
    if (selection?.activation === 'disabled') {
      return { thinking: { type: 'disabled' } };
    }
    if (mapping.mode === 'budget') {
      return typeof selection?.budgetTokens === 'number'
        ? {
            thinking: {
              type: 'enabled',
              budget_tokens: selection.budgetTokens,
            },
          }
        : {};
    }
    const effort = selection?.effort;
    return {
      thinking: { type: 'adaptive' },
      ...(effort && effort !== 'minimal' ? { outputConfig: { effort } } : {}),
    };
  }

  /** 将统一选择映射为 Gemini thinkingConfig。 */
  private createGeminiThinkingConfig(
    request: ResolvedLlmTextRequest,
  ): GoogleGenerativeAIChatInput['thinkingConfig'] {
    const capability = findModelReasoningCapability(
      request.model.platform,
      request.model.upstreamFormat,
      request.model.model,
    );
    const mapping = capability?.requestMapping;
    const selection = request.reasoning;
    if (!mapping || mapping.kind !== 'gemini') {
      return undefined;
    }
    if (mapping.mode === 'budget') {
      return {
        thinkingBudget:
          selection?.activation === 'disabled'
            ? 0
            : selection?.budgetTokens === 'auto' ||
                selection?.budgetTokens === undefined
              ? -1
              : selection.budgetTokens,
      };
    }
    if (!selection?.effort || selection.effort === 'minimal') {
      return undefined;
    }
    if (selection.effort === 'low') {
      return { thinkingLevel: 'LOW' };
    }
    if (selection.effort === 'medium') {
      return { thinkingLevel: 'MEDIUM' };
    }
    return selection.effort === 'high' ? { thinkingLevel: 'HIGH' } : undefined;
  }
}
