import { Injectable } from '@nestjs/common';
import type {
  ApprovalDecision,
  PlanReviewDecision,
} from '@litter-bear/types/protocol';
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
      threadId: input.threadId,
      approvalToolNames: input.approvalToolNames,
      abortSignal: input.abortSignal,
    })) {
      yield event;
    }
  }

  /**
   * 从人工审批中断处恢复
   * @param input agent loop 输入（需 threadId，且工具/审批集与首轮一致）
   * @param decision 人工决定
   * @returns 返回续跑的事件流
   * @description 用同一 checkpointer + thread_id 重建 agent，通过 Command 从中断处续跑。
   * 图状态来自检查点，故不需要重放首轮消息。
   */
  resume(
    input: AgentLoopInput,
    decision: ApprovalDecision | PlanReviewDecision,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    // ReAct 只会撞工具审批,永远不会收到计划审批决定(那只在 plan_execute 出现);
    // 接口取联合是为满足 AgentStrategyGraph,这里收窄回工具审批决定。
    return this.commonChatAgentService.resumeEvents({
      messages: input.messages,
      systemPrompt: input.systemPrompt,
      llm: input.llm,
      tools: input.tools,
      threadId: input.threadId,
      approvalToolNames: input.approvalToolNames,
      decision: decision as ApprovalDecision,
      abortSignal: input.abortSignal,
    });
  }
}
