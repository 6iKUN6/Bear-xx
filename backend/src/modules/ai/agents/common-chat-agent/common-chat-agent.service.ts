import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { LlmService } from '../../../llm/llm.service';
import type {
  LlmGenerationConfig,
  LlmMessage,
  LlmModelPreset,
  LlmTextRequest,
  ResolvedLlmTextRequest,
} from '../../../llm/llm.types';

type ChatModelStreamChunk = {
  content: unknown;
};

type ChatModelLike = {
  stream(
    input: unknown,
    options?: { signal?: AbortSignal },
  ):
    | Promise<AsyncIterable<ChatModelStreamChunk>>
    | AsyncIterable<ChatModelStreamChunk>;
};

type ToolBindableChatModel = ChatModelLike & {
  bindTools?: (tools: unknown[]) => ChatModelLike;
};

export interface CommonChatAgentRequest {
  modelPreset?: string | LlmModelPreset;
  llm?: LlmTextRequest | ResolvedLlmTextRequest;
  messages: LlmMessage[];
  generation?: LlmGenerationConfig;
  tools?: unknown[];
  abortSignal?: AbortSignal;
}

export type CommonChatAgentStreamEvent =
  | {
      type: 'message.delta';
      delta: string;
    }
  | {
      type: 'tool.call.delta';
      toolCallId?: string;
      name?: string;
      args?: string;
      index?: number;
    };

@Injectable()
export class CommonChatAgentService {
  constructor(
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 流式执行通用聊天智能体
   * @param request 通用聊天智能体请求配置
   * @returns 返回模型输出的文本分片异步迭代器
   * @description 兼容旧调用方：将智能体结构化事件中的文本增量重新收敛为纯字符串流。
   */
  async *stream(
    request: CommonChatAgentRequest,
  ): AsyncGenerator<string, void, unknown> {
    for await (const event of this.streamEvents(request)) {
      if (event.type === 'message.delta') {
        yield event.delta;
      }
    }
  }

  /**
   * 流式执行通用聊天智能体并返回结构化事件
   * @param request 通用聊天智能体请求配置
   * @returns 返回智能体结构化事件流
   * @description 在 agent 层完成消息组装、模型创建、可选工具绑定和 chunk 解析，为后续工具调用链保留独立事件通道。
   */
  streamEvents(
    request: CommonChatAgentRequest,
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const llmRequest = this.buildLlmRequest(request);

    return this.createEventStream(
      request.messages,
      llmRequest,
      request.tools,
      request.abortSignal,
    );
  }

  /**
   * 解析文本生成请求
   * @param request 文本生成请求配置
   * @returns 返回已解析完成的模型与生成参数配置
   * @description 对外暴露 agent 使用的模型解析能力，让聊天任务模块不需要直接依赖 LLM 模块。
   */
  resolveTextRequest(
    request?: LlmTextRequest | ResolvedLlmTextRequest,
  ): ResolvedLlmTextRequest {
    return this.llmService.resolveTextRequest(request);
  }

  /**
   * 构建模型请求配置
   * @param request 通用聊天智能体请求配置
   * @returns 返回 llm 模块可直接消费的模型请求配置
   * @description 支持传入模型预设 ID 或完整模型预设对象；若为完整预设对象，则直接构造已解析请求，避免依赖预注册模型列表。
   */
  private buildLlmRequest(
    request: CommonChatAgentRequest,
  ): LlmTextRequest | ResolvedLlmTextRequest {
    if (request.llm) {
      return request.llm;
    }

    if (typeof request.modelPreset === 'string') {
      return {
        model: {
          modelId: request.modelPreset,
        },
        generation: request.generation,
      };
    }

    if (!request.modelPreset) {
      return {
        generation: request.generation,
      };
    }

    return {
      model: {
        id: request.modelPreset.id,
        provider: request.modelPreset.provider,
        platform: request.modelPreset.platform,
        model: request.modelPreset.model,
        apiKey: request.modelPreset.apiKey,
        baseURL: request.modelPreset.baseURL,
      },
      generation: {
        temperature:
          request.generation?.temperature ?? request.modelPreset.temperature,
        maxOutputTokens:
          request.generation?.maxOutputTokens ??
          request.modelPreset.maxOutputTokens,
        topP: request.generation?.topP ?? request.modelPreset.topP,
      },
    };
  }

  /**
   * 创建智能体事件流
   * @param messages 聊天消息列表
   * @param llmRequest 模型请求配置
   * @param tools 可选工具列表
   * @param abortSignal 中断信号
   * @returns 返回智能体结构化事件异步迭代器
   * @description 在 agent 层消费模型原始 chunk，并拆分成文本增量和工具调用增量事件。
   */
  private async *createEventStream(
    messages: LlmMessage[],
    llmRequest: LlmTextRequest | ResolvedLlmTextRequest,
    tools?: unknown[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const resolvedRequest = this.llmService.resolveTextRequest(llmRequest);
    const chatModel = this.bindToolsIfNeeded(
      this.llmService.createChatModel(resolvedRequest) as ToolBindableChatModel,
      tools,
    );
    const langChainMessages = this.toLangChainMessages(messages);

    this.debugLog('agent.common_chat.request', {
      model: this.toSafeModelLog(resolvedRequest),
      messageCount: messages.length,
      generation: resolvedRequest.generation,
      toolCount: tools?.length ?? 0,
      hasAbortSignal: Boolean(abortSignal),
    });

    const stream = await chatModel.stream(langChainMessages, {
      signal: abortSignal,
    });

    for await (const chunk of stream) {
      const delta = this.readChunkText(chunk.content);
      const toolCallDeltas = this.readToolCallDeltas(chunk);

      if (delta) {
        yield {
          type: 'message.delta',
          delta,
        };
      }

      for (const toolCallDelta of toolCallDeltas) {
        yield toolCallDelta;
      }
    }
  }

  /**
   * 按需绑定工具
   * @param chatModel 聊天模型实例
   * @param tools 可选工具列表
   * @returns 返回可流式调用的模型或工具绑定后的 Runnable
   * @description 工具绑定放在 agent 层处理，避免 LLM 模块理解业务工具链。
   */
  private bindToolsIfNeeded(
    chatModel: ToolBindableChatModel,
    tools?: unknown[],
  ): ChatModelLike {
    if (!tools?.length) {
      return chatModel;
    }

    if (typeof chatModel.bindTools !== 'function') {
      throw new Error('当前模型不支持工具绑定');
    }

    return chatModel.bindTools(tools);
  }

  /**
   * 转换为 LangChain 消息列表
   * @param messages 通用聊天消息列表
   * @returns 返回 LangChain BaseMessage 数组
   * @description 将系统内部统一的消息结构转换为 LangChain 消费的消息对象。
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

  /**
   * 读取工具调用增量
   * @param chunk LangChain 返回的消息分片
   * @returns 返回工具调用增量事件列表
   * @description 兼容 LangChain AIMessageChunk 的 tool_call_chunks 结构，为后续工具执行链保留事件出口。
   */
  private readToolCallDeltas(
    chunk: ChatModelStreamChunk,
  ): Array<Extract<CommonChatAgentStreamEvent, { type: 'tool.call.delta' }>> {
    const record = chunk as Record<string, unknown>;
    if (!Array.isArray(record.tool_call_chunks)) {
      return [];
    }

    const events: Array<
      Extract<CommonChatAgentStreamEvent, { type: 'tool.call.delta' }>
    > = [];

    for (const item of record.tool_call_chunks) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const toolCallChunk = item as Record<string, unknown>;
      events.push({
        type: 'tool.call.delta',
        toolCallId: this.readOptionalString(toolCallChunk.id),
        name: this.readOptionalString(toolCallChunk.name),
        args: this.stringifyOptionalValue(toolCallChunk.args),
        index: this.readOptionalNumber(toolCallChunk.index),
      });
    }

    return events;
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

  private formatLog(event: string, payload: Record<string, unknown>) {
    return JSON.stringify({
      event,
      ...payload,
    });
  }

  private debugLog(event: string, payload: Record<string, unknown>) {
    if (!this.isDebugEnabled()) {
      return;
    }

    Logger.log(this.formatLog(event, payload), CommonChatAgentService.name);
  }

  private isDebugEnabled() {
    return this.readBooleanConfig('LLM_DEBUG');
  }

  private readBooleanConfig(key: string) {
    const value = this.configService.get<string>(key);
    return value === 'true' || value === '1';
  }

  private readOptionalString(value: unknown) {
    return typeof value === 'string' && value ? value : undefined;
  }

  private readOptionalNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }

  private stringifyOptionalValue(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === 'string') {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch {
      if (value instanceof Error) {
        return value.message;
      }

      if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        typeof value === 'bigint' ||
        typeof value === 'symbol'
      ) {
        return value.toString();
      }

      return '[unserializable]';
    }
  }
}
