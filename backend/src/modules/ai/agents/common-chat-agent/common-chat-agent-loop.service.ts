import { Injectable, Logger } from '@nestjs/common';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LlmMessage } from '../../../llm/llm.types';
import {
  type CommonChatAgentLoopRequest,
  type CommonChatAgentStreamEvent,
} from './common-chat-agent.types';
import { CommonChatAgentFactory } from './common-chat-agent.factory';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';

@Injectable()
export class CommonChatAgentLoopService {
  private readonly logger = new Logger(CommonChatAgentLoopService.name);

  constructor(private readonly agentFactory: CommonChatAgentFactory) {}

  /**
   * 执行通用聊天 agent loop
   * @param request agent loop 请求参数
   * @returns 返回项目内部统一的 agent 结构化事件流
   * @description 使用 LangChain createAgent 创建并运行 agent loop，同时把 LangChain v3 stream 重新映射为当前 StreamTask 可消费的 message.delta/tool.call.delta 事件。
   */
  async *stream(
    request: CommonChatAgentLoopRequest & { model: BaseChatModel },
  ): AsyncGenerator<CommonChatAgentStreamEvent, void, unknown> {
    const agent = this.agentFactory.createAgent({
      model: request.model,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
    });

    const run = await agent.streamEvents(
      {
        messages: this.toLangChainMessages(request.messages),
      },
      {
        version: 'v3',
        signal: request.abortSignal,
        configurable: {},
      },
    );

    const eventQueue = new AsyncEventQueue<CommonChatAgentStreamEvent>();
    const consumers = [
      this.consumeMessageStream(run.messages, eventQueue),
      this.consumeToolCallStream(run.toolCalls, eventQueue),
      this.waitForRunOutput(run.output, eventQueue),
    ];

    void Promise.all(consumers).then(
      () => eventQueue.close(),
      (error: unknown) => eventQueue.fail(error),
    );

    for await (const event of eventQueue) {
      yield event;
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

  private readOptionalString(value: unknown) {
    return typeof value === 'string' && value ? value : undefined;
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
    } catch (error) {
      this.logger.warn(
        `Serialize tool call input failed: ${(error as Error).message}`,
      );
      return '[unserializable]';
    }
  }

  /**
   * 消费 LangChain 文本消息流
   * @param messages LangChain 消息流
   * @param queue 内部事件队列
   * @returns 无返回值
   * @description 与工具调用流并发消费，避免工具事件被完整文本流阻塞。
   */
  private async consumeMessageStream(
    messages: AsyncIterable<{ text: AsyncIterable<string> }>,
    queue: AsyncEventQueue<CommonChatAgentStreamEvent>,
  ) {
    for await (const message of messages) {
      for await (const delta of message.text) {
        if (!delta) {
          continue;
        }

        queue.push({
          type: StreamTaskEventType.MessageDelta,
          delta,
        });
      }
    }
  }

  /**
   * 消费 LangChain 工具调用流
   * @param toolCalls LangChain 工具调用流
   * @param queue 内部事件队列
   * @returns 无返回值
   * @description 工具调用对象一出现就发布 start/delta，并在 output/status/error 完成后发布 done/error。
   */
  private async consumeToolCallStream(
    toolCalls: AsyncIterable<ToolCallStreamLike>,
    queue: AsyncEventQueue<CommonChatAgentStreamEvent>,
  ) {
    const completionWatchers: Array<Promise<void>> = [];
    let index = 0;

    for await (const toolCall of toolCalls) {
      const toolIndex = index;
      index += 1;

      queue.push({
        type: StreamTaskEventType.ToolCallStart,
        payload: this.buildToolCallPayload(toolCall, toolIndex, {
          publicStatus: `正在调用工具${this.formatNameSuffix(toolCall.name)}`,
          inputSummary: this.toJsonSummary(toolCall.input),
        }),
      });

      queue.push({
        type: StreamTaskEventType.ToolCallDelta,
        toolCallId: this.readOptionalString(toolCall.callId),
        name: this.readOptionalString(toolCall.name),
        args: this.stringifyOptionalValue(toolCall.input),
        index: toolIndex,
      });

      completionWatchers.push(
        this.emitToolCallCompletion(toolCall, toolIndex, queue),
      );
    }

    await Promise.all(completionWatchers);
  }

  private async waitForRunOutput(
    output: Promise<unknown>,
    _queue: AsyncEventQueue<CommonChatAgentStreamEvent>,
  ) {
    await output;
  }

  private async emitToolCallCompletion(
    toolCall: ToolCallStreamLike,
    index: number,
    queue: AsyncEventQueue<CommonChatAgentStreamEvent>,
  ) {
    const [outputResult, statusResult, errorResult] = await Promise.allSettled([
      Promise.resolve(toolCall.output),
      Promise.resolve(toolCall.status),
      Promise.resolve(toolCall.error),
    ]);
    const status =
      statusResult.status === 'fulfilled'
        ? this.readOptionalString(statusResult.value)
        : undefined;
    const errorMessage =
      errorResult.status === 'fulfilled'
        ? this.readOptionalString(errorResult.value)
        : errorResult.reason instanceof Error
          ? errorResult.reason.message
          : this.readOptionalString(errorResult.reason);

    if (
      status === 'error' ||
      outputResult.status === 'rejected' ||
      errorMessage
    ) {
      queue.push({
        type: StreamTaskEventType.ToolCallError,
        payload: this.buildToolCallPayload(toolCall, index, {
          publicStatus: `工具调用失败${this.formatNameSuffix(toolCall.name)}`,
          message:
            errorMessage ??
            (outputResult.status === 'rejected'
              ? this.stringifyUnknownError(outputResult.reason)
              : '工具调用失败'),
          error: {
            message:
              errorMessage ??
              (outputResult.status === 'rejected'
                ? this.stringifyUnknownError(outputResult.reason)
                : '工具调用失败'),
          },
        }),
      });
      return;
    }

    queue.push({
      type: StreamTaskEventType.ToolCallDone,
      payload: this.buildToolCallPayload(toolCall, index, {
        publicStatus: `工具调用完成${this.formatNameSuffix(toolCall.name)}`,
        outputSummary:
          outputResult.status === 'fulfilled'
            ? this.toJsonSummary(outputResult.value)
            : undefined,
      }),
    });
  }

  private buildToolCallPayload(
    toolCall: ToolCallStreamLike,
    index: number,
    extra: Record<string, unknown>,
  ) {
    const toolCallId = this.readOptionalString(toolCall.callId);
    const name = this.readOptionalString(toolCall.name);
    return {
      toolCallId,
      name,
      toolName: name,
      args: this.stringifyOptionalValue(toolCall.input),
      index,
      nodeKey: 'common_chat_tool',
      traceKey: `tool:${toolCallId ?? name ?? index}`,
      ...extra,
    };
  }

  private formatNameSuffix(value: unknown) {
    const name = this.readOptionalString(value);
    return name ? `：${name}` : '';
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
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    }

    if (typeof value === 'symbol') {
      return { value: value.description ?? value.toString() };
    }

    return { value: '[unsupported]' };
  }

  private stringifyUnknownError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

interface ToolCallStreamLike {
  name?: unknown;
  callId?: unknown;
  input?: unknown;
  output?: unknown;
  status?: unknown;
  error?: unknown;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private closed = false;
  private error?: Error;
  private wake?: () => void;

  push(item: T) {
    if (this.closed || this.error) {
      return;
    }

    this.items.push(item);
    this.notify();
  }

  close() {
    if (this.closed || this.error) {
      return;
    }

    this.closed = true;
    this.notify();
  }

  fail(error: unknown) {
    if (this.closed || this.error) {
      return;
    }

    this.error = error instanceof Error ? error : new Error(String(error));
    this.notify();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }

      if (this.error) {
        throw this.error;
      }

      if (this.closed) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private notify() {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
