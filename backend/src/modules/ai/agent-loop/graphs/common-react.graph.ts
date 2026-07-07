import { Injectable } from '@nestjs/common';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';
import { CommonChatAgentService } from '../../agents/common-chat-agent/common-chat-agent.service';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyGraph,
} from '../agent-loop.types';

@Injectable()
export class CommonReactGraph implements AgentStrategyGraph {
  readonly mode = AgentStrategyMode.ReAct;

  constructor(
    private readonly commonChatAgentService: CommonChatAgentService,
  ) {}

  /**
   * 执行 ReAct 策略
   * @param input agent loop 输入上下文
   * @returns 返回 ReAct agent loop 事件流
   * @description 复用现有 common-chat createAgent 链路，让模型在回答过程中按需调用工具。
   */
  async *stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    yield {
      type: StreamTaskEventType.AgentLoopStart,
      payload: {
        nodeKey: 'common_chat_react',
        traceKey: 'agent-loop:common_chat_react',
        agent: 'common-chat-agent',
        strategy: this.mode,
        publicStatus: '正在分析并准备调用工具',
      },
    };

    try {
      for await (const event of this.commonChatAgentService.streamEvents({
        messages: input.messages,
        systemPrompt: input.systemPrompt,
        llm: input.llm,
        tools: input.tools,
        abortSignal: input.abortSignal,
      })) {
        yield event;
      }
    } catch (error) {
      if (!this.isToolProtocolError(error)) {
        throw error;
      }

      yield {
        type: StreamTaskEventType.ToolCallError,
        payload: {
          nodeKey: 'common_chat_react',
          traceKey: 'tool:common_chat_react',
          publicStatus: '工具调用失败，正在降级回复',
          message: error instanceof Error ? error.message : String(error),
        },
      };

      yield {
        type: StreamTaskEventType.MessageDelta,
        delta:
          '天气查询工具暂时不可用，刚才的工具调用没有完成。你可以稍后再试，或者告诉我更明确的城市名称，我再帮你重新查询。',
      };
    }
  }

  /**
   * 判断是否为模型工具协议错误
   * @param error agent 执行异常
   * @returns 返回 true 表示可降级为工具失败事件
   * @description OpenAI Responses API 或兼容服务在 function_call_output 找不到对应 call_id 时会抛出该类错误，不应让整轮 StreamTask 直接失败。
   */
  private isToolProtocolError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('No tool call found') ||
      message.includes('function call output') ||
      message.includes('tool_call_id') ||
      message.includes('call_id')
    );
  }
}
