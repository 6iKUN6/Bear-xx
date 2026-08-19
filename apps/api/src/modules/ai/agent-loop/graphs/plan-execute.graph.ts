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
