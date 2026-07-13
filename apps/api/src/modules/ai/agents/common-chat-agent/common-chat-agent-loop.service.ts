import { Injectable, Logger } from '@nestjs/common';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type {
  AIMessageChunk,
  BaseMessage,
  BaseMessageChunk,
  ToolMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LlmMessage } from '../../../llm/llm.types';
import {
  type CommonChatAgentLoopRequest,
  type CommonChatAgentStreamEvent,
} from './common-chat-agent.types';
import { CommonChatAgentFactory } from './common-chat-agent.factory';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';

type MessagesModeChunk = [BaseMessageChunk, Record<string, unknown>];

@Injectable()
export class CommonChatAgentLoopService {
  private readonly logger = new Logger(CommonChatAgentLoopService.name);

  constructor(private readonly agentFactory: CommonChatAgentFactory) {}

  /**
   * 执行通用聊天 agent loop
   * @param request agent loop 请求参数
   * @returns 返回项目内部统一的 agent 结构化事件流
   * @description 使用 LangChain createAgent 运行 agent loop，并以 stream({ streamMode: 'messages' }) 消费单条有序消息流，
   * 映射为 StreamTask 可消费的 message.delta / tool.call.* 事件。之所以不用 streamEvents({version:'v3'})：
   * 该投影式流式在部分 OpenAI 兼容代理下会让工具调用走 Responses 语义（fc_ 前缀 call_id）导致回填工具结果 400；
   * messages 模式走普通 Chat Completions 流式，工具调用 id 正常（call_）且保留 token 级增量。
   */
  async *stream(
    request: CommonChatAgentLoopRequest & { model: BaseChatModel },
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const agent = this.agentFactory.createAgent({
      model: request.model,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
    });

    const stream = (await agent.stream(
      { messages: this.toLangChainMessages(request.messages) },
      {
        streamMode: 'messages',
        signal: request.abortSignal,
        configurable: {},
      },
    )) as unknown as AsyncIterable<MessagesModeChunk>;

    // 工具调用增量的起始 chunk 带 id/name，后续 arg 分片仅有 args 无 id，需跟踪当前工具调用。
    const toolIndexById = new Map<string, number>();
    const toolNameById = new Map<string, string>();
    let nextToolIndex = 0;
    let lastToolCallId: string | undefined;

    for await (const [message] of stream) {
      const messageType = message.getType();

      if (messageType === 'tool') {
        yield this.buildToolResultEvent(
          message as unknown as ToolMessage,
          toolIndexById,
          toolNameById,
        );
        continue;
      }

      if (messageType !== 'ai') {
        continue;
      }

      const aiChunk = message as AIMessageChunk;

      const text = this.readMessageText(aiChunk.content);
      if (text) {
        yield { type: StreamTaskEventType.MessageDelta, delta: text };
      }

      for (const chunk of aiChunk.tool_call_chunks ?? []) {
        const callId = this.readOptionalString(chunk.id) ?? lastToolCallId;
        if (!callId) {
          continue;
        }
        lastToolCallId = callId;

        const chunkName = this.readOptionalString(chunk.name);
        if (chunkName && !toolNameById.has(callId)) {
          toolNameById.set(callId, chunkName);
        }

        if (!toolIndexById.has(callId)) {
          const index = nextToolIndex;
          nextToolIndex += 1;
          toolIndexById.set(callId, index);

          const name = toolNameById.get(callId);
          yield {
            type: StreamTaskEventType.ToolCallStart,
            payload: this.buildToolPayload(callId, name, index, {
              publicStatus: `正在调用工具${this.formatNameSuffix(name)}`,
            }),
          };
        }

        yield {
          type: StreamTaskEventType.ToolCallDelta,
          toolCallId: callId,
          name: toolNameById.get(callId),
          args: this.readOptionalString(chunk.args),
          index: toolIndexById.get(callId),
        };
      }
    }
  }

  /**
   * 转换为 LangChain 消息列表
   * @param messages 通用聊天消息列表
   * @returns 返回 LangChain BaseMessage 数组
   * @description 将系统内部统一消息结构转换为 LangChain agent state 可消费的消息对象。
   */
  private toLangChainMessages(messages: LlmMessage[]): BaseMessage[] {
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
   * 构建工具执行结果事件
   * @param message LangChain 工具结果消息
   * @param toolIndexById 工具调用 id 到序号的映射
   * @param toolNameById 工具调用 id 到名称的映射
   * @returns 返回工具完成或失败事件
   * @description 依据 ToolMessage.status 区分成功/失败，输出摘要取工具返回内容。
   */
  private buildToolResultEvent(
    message: ToolMessage,
    toolIndexById: Map<string, number>,
    toolNameById: Map<string, string>,
  ): CommonChatAgentStreamEvent {
    const callId = this.readOptionalString(message.tool_call_id);
    const index = callId ? (toolIndexById.get(callId) ?? -1) : -1;
    const name = callId ? toolNameById.get(callId) : undefined;
    const content = this.readMessageText(message.content);

    if (this.readOptionalString(message.status) === 'error') {
      const errorMessage = content || '工具调用失败';
      return {
        type: StreamTaskEventType.ToolCallError,
        payload: this.buildToolPayload(callId, name, index, {
          publicStatus: `工具调用失败${this.formatNameSuffix(name)}`,
          message: errorMessage,
          error: { message: errorMessage },
        }),
      };
    }

    return {
      type: StreamTaskEventType.ToolCallDone,
      payload: this.buildToolPayload(callId, name, index, {
        publicStatus: `工具调用完成${this.formatNameSuffix(name)}`,
        outputSummary: this.toJsonSummary(message.content),
      }),
    };
  }

  private buildToolPayload(
    callId: string | undefined,
    name: string | undefined,
    index: number,
    extra: Record<string, unknown>,
  ) {
    return {
      toolCallId: callId,
      name,
      toolName: name,
      index,
      nodeKey: 'common_chat_tool',
      traceKey: `tool:${callId ?? name ?? index}`,
      ...extra,
    };
  }

  private formatNameSuffix(value: unknown) {
    const name = this.readOptionalString(value);
    return name ? `：${name}` : '';
  }

  private readOptionalString(value: unknown) {
    return typeof value === 'string' && value ? value : undefined;
  }

  /**
   * 读取消息内容中的纯文本
   * @param content LangChain 消息内容
   * @returns 返回可用于 SSE delta 的纯文本
   * @description 兼容字符串与内容块数组两种结构，仅提取文本部分。
   */
  private readMessageText(content: unknown): string {
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
        return record.type === 'text' && typeof record.text === 'string'
          ? record.text
          : '';
      })
      .join('');
  }

  private toJsonSummary(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === 'string') {
      return { text: value };
    }

    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return { value: value.toString() };
    }

    if (typeof value === 'object') {
      try {
        return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
      } catch (error) {
        this.logger.warn(
          `Serialize tool output failed: ${(error as Error).message}`,
        );
        return { value: '[unserializable]' };
      }
    }

    return { value: '[unsupported]' };
  }
}
