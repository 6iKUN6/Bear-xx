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

    for await (const message of run.messages) {
      for await (const delta of message.text) {
        if (!delta) {
          continue;
        }

        yield {
          type: StreamTaskEventType.MessageDelta,
          delta,
        };
      }
    }

    for await (const toolCall of run.toolCalls) {
      yield {
        type: StreamTaskEventType.ToolCallDelta,
        toolCallId: this.readOptionalString(toolCall.callId),
        name: this.readOptionalString(toolCall.name),
        args: this.stringifyOptionalValue(toolCall.input),
      };
    }

    await run.output;
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
}
