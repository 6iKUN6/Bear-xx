import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAICompletions } from '@langchain/openai';
import type { ResolvedLlmTextRequest } from '../llm.types';
import { incrementModelCall } from '../../ai/telemetry/model-call-context';

/**
 * 模型调用计数回调
 * @description 每次真实模型调用开始时累加到当前任务的计数上下文（不在上下文中则静默）。
 * agent 路径与直连路径都经模型构造，此回调是唯一交汇点，能覆盖 ReAct 内部多次往返。
 */
const MODEL_CALL_COUNTER_CALLBACK = {
  handleChatModelStart: () => incrementModelCall(),
};

/** LLM 调用健壮性默认值：重试次数与单次请求超时 */
const DEFAULT_LLM_MAX_RETRIES = 3;
const DEFAULT_LLM_TIMEOUT_MS = 30000;

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
    const { maxRetries, timeoutMs } = this.resolveResilienceOptions();

    return new ChatOpenAICompletions({
      model: model.model,
      apiKey: model.apiKey ?? this.configService.get<string>('OPENAI_API_KEY'),
      temperature: generation.temperature,
      maxTokens: generation.maxOutputTokens,
      topP: generation.topP,
      maxRetries,
      timeout: timeoutMs,
      callbacks: [MODEL_CALL_COUNTER_CALLBACK],
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
    const { maxRetries, timeoutMs } = this.resolveResilienceOptions();

    return new ChatAnthropic({
      model: model.model,
      apiKey:
        model.apiKey ?? this.configService.get<string>('ANTHROPIC_API_KEY'),
      anthropicApiUrl:
        model.baseURL ?? this.configService.get<string>('ANTHROPIC_BASE_URL'),
      temperature: generation.temperature,
      maxTokens: generation.maxOutputTokens,
      topP: generation.topP,
      maxRetries,
      callbacks: [MODEL_CALL_COUNTER_CALLBACK],
      // Anthropic SDK 的超时通过 clientOptions 透传（无顶层 timeout 参数）。
      clientOptions: { timeout: timeoutMs },
    });
  }
}
