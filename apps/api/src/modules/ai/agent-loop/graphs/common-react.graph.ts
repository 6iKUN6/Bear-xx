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
   * @description 复用统一 agent executor（createAgent），让模型在回答过程中按需调用工具；工具级失败由 executor 映射为 tool.call.error 事件，其余执行错误直接上抛由上层收敛为任务失败。
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

    for await (const event of this.commonChatAgentService.streamEvents({
      messages: input.messages,
      systemPrompt: input.systemPrompt,
      llm: input.llm,
      tools: input.tools,
      abortSignal: input.abortSignal,
    })) {
      yield event;
    }
  }
}
