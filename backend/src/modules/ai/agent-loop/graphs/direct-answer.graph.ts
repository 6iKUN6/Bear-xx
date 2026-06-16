import { Injectable } from '@nestjs/common';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';
import { LlmService } from '../../../llm/llm.service';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyGraph,
} from '../agent-loop.types';

@Injectable()
export class DirectAnswerGraph implements AgentStrategyGraph {
  readonly mode = AgentStrategyMode.Direct;

  constructor(private readonly llmService: LlmService) {}

  /**
   * 执行直接回答策略
   * @param input agent loop 输入上下文
   * @returns 返回模型直出事件流
   * @description 不主动调用工具，直接通过 LLM 生成回答，并补充模型调用开始与完成事件供前端展示状态。
   */
  async *stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    yield {
      type: StreamTaskEventType.ModelCallStart,
      payload: {
        model: input.llm?.model.model,
        provider: input.llm?.model.provider,
        publicStatus: '正在生成回复',
      },
    };

    try {
      for await (const delta of this.llmService.streamChatText(
        this.withSystemPrompt(input),
        input.llm,
        { abortSignal: input.abortSignal },
      )) {
        yield {
          type: StreamTaskEventType.MessageDelta,
          delta,
        };
      }

      yield {
        type: StreamTaskEventType.ModelCallDone,
        payload: {
          model: input.llm?.model.model,
          provider: input.llm?.model.provider,
        },
      };
    } catch (error) {
      yield {
        type: StreamTaskEventType.ModelCallDone,
        payload: {
          model: input.llm?.model.model,
          provider: input.llm?.model.provider,
          error: error instanceof Error ? error.message : String(error),
        },
      };
      throw error;
    }
  }

  private withSystemPrompt(input: AgentLoopInput) {
    if (!input.systemPrompt) {
      return input.messages;
    }

    return [
      {
        role: 'system' as const,
        content: input.systemPrompt,
      },
      ...input.messages,
    ];
  }
}
