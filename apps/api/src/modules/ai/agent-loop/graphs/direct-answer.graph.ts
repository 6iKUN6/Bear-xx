import { Injectable } from '@nestjs/common';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';
import { CommonChatAgentService } from '../../agents/common-chat-agent/common-chat-agent.service';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyGraph,
} from '../agent-loop.types';

/**
 * @deprecated 旧编排链路，**已不可达**，等待删除。
 *
 * Flow 已成为唯一编排路径：`resolveTaskFlowSnapshot` 现在总会给聊天任务锁定一份
 * Definition（Agent 绑了用它的，没绑用内置 direct Flow），因此 `ensureTaskExecution`
 * 永远走 Flow 分支，`runChatTask` 及其下游整条链都进不去。
 *
 * 保留数个版本再删，不是因为还有用，而是给回滚留余地。删除时机与边界见
 * `apps/api/docs/agent-flow-as-single-runtime.md` §2、§7。
 *
 * 不要在这里加新功能，也不要把它当作「长短任务分流」的复用基础——那条路要基于
 * Flow 的 activities 重写，与本链路无关。
 */

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
