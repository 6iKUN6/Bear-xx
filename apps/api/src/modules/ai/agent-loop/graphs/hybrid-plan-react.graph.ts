import { Injectable } from '@nestjs/common';
import type {
  ApprovalDecision,
  PlanReviewDecision,
} from '@litter-bear/types/protocol';
import { PlanGraphRunner } from '../execution/plan-graph.runner';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyGraph,
} from '../agent-loop.types';

@Injectable()
export class HybridPlanReactGraph implements AgentStrategyGraph {
  readonly mode = AgentStrategyMode.Hybrid;

  constructor(private readonly runner: PlanGraphRunner) {}

  /**
   * 执行混合策略
   * @param input agent loop 输入上下文
   * @returns 返回计划与动态执行混合的事件流
   * @description 动态模式：规划后逐步执行，每步后用评估器判断信息是否足够以提前收尾，最后综合输出。
   */
  stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    return this.runner.stream(input, this.mode);
  }

  /**
   * 从人工审批中断处恢复
   * @description 用同一 thread_id 重建同形状的编排图，把决定送回中断处续跑。
   */
  resume(
    input: AgentLoopInput,
    decision: ApprovalDecision | PlanReviewDecision,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    return this.runner.resume(input, this.mode, decision);
  }
}
