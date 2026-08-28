import { Injectable } from '@nestjs/common';
import type {
  ApprovalDecision,
  PlanReviewDecision,
} from '@litter-bear/types/protocol';
import { PlanGraphRunner } from '../execution/plan-graph/plan-graph.runner';
import { resolvePlanLoopPolicy } from '../execution/plan-graph/plan-loop-policy';
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
export class PlanExecuteGraph implements AgentStrategyGraph {
  readonly mode = AgentStrategyMode.PlanExecute;

  constructor(private readonly runner: PlanGraphRunner) {}

  /**
   * 执行计划-执行策略
   * @param input agent loop 输入上下文
   * @returns 返回带真实步骤事件的事件流
   * @description 静态模式：先规划再逐步执行，跑完全部步骤后综合输出。
   */
  stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    return this.runner.stream(
      input,
      resolvePlanLoopPolicy(this.mode, input.maxSteps),
    );
  }

  /**
   * 从人工审批中断处恢复
   * @description 用同一 thread_id 重建同形状的编排图，把决定送回中断处续跑。
   */
  resume(
    input: AgentLoopInput,
    decision: ApprovalDecision | PlanReviewDecision,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    return this.runner.resume(
      input,
      resolvePlanLoopPolicy(this.mode, input.maxSteps),
      decision,
    );
  }
}
