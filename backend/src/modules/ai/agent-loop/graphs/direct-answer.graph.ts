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
export class DirectAnswerGraph implements AgentStrategyGraph {
  readonly mode = AgentStrategyMode.Direct;

  constructor(
    private readonly commonChatAgentService: CommonChatAgentService,
  ) {}

  /**
   * 执行直接回答策略
   * @param input agent loop 输入上下文
   * @returns 返回模型直出事件流
   * @description 复用统一 agent executor（createAgent），不装载任何工具直接生成回答；与 ReAct 共用同一条执行和事件映射链路，避免直答与工具调用两套实现分叉。模型调用开始/完成事件仅作为前端状态书签。
   */
  async *stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    yield {
      type: StreamTaskEventType.ModelCallStart,
      payload: {
        nodeKey: 'direct_answer_model',
        traceKey: 'model:direct_answer',
        model: input.llm?.model.model,
        provider: input.llm?.model.provider,
        publicStatus: '正在生成回复',
      },
    };

    for await (const event of this.commonChatAgentService.streamEvents({
      messages: input.messages,
      systemPrompt: input.systemPrompt,
      llm: input.llm,
      tools: [],
      abortSignal: input.abortSignal,
    })) {
      yield event;
    }

    yield {
      type: StreamTaskEventType.ModelCallDone,
      payload: {
        nodeKey: 'direct_answer_model',
        traceKey: 'model:direct_answer',
        model: input.llm?.model.model,
        provider: input.llm?.model.provider,
      },
    };
  }
}
