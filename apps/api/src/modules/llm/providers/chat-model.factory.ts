import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LLMResult } from '@langchain/core/outputs';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAICompletions, ChatOpenAIResponses } from '@langchain/openai';
import type { ResolvedLlmTextRequest } from '../llm.types';
import {
  recordModelCallEnd,
  recordModelCallStart,
} from '../../ai/telemetry/model-call-context';

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
    switch (request.model.upstreamFormat) {
      case 'anthropic_messages':
        return this.createAnthropicChatModel(request);
      case 'openai_responses':
        return this.createOpenAiResponsesChatModel(request);
      case 'openai_chat_completions':
        return this.createOpenAiCompatibleChatModel(request);
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
  ): BaseChatModel {
    const { model, generation } = request;
    const { maxRetries, timeoutMs } = this.resolveResilienceOptions();

    return new ChatOpenAICompletions({
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
      apiKey: model.apiKey,
      anthropicApiUrl: model.baseURL,
      temperature: generation.temperature,
      maxTokens: generation.maxOutputTokens,
      topP: generation.topP,
      maxRetries,
      callbacks: [MODEL_CALL_USAGE_CALLBACK],
      // Anthropic SDK 的超时通过 clientOptions 透传（无顶层 timeout 参数）。
      clientOptions: { timeout: timeoutMs },
    });
  }
}
