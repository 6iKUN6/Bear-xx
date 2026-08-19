import { Injectable } from '@nestjs/common';
import type {
  ApprovalDecision,
  PlanReviewDecision,
} from '@litter-bear/types/protocol';
import type {
  AgentLoopInput,
  AgentLoopStreamEvent,
} from '../../agent-loop.types';
import type { PlanLoopPolicy } from './plan-loop-policy';
import { PlanGraphBuilder } from './plan-graph.builder';

/**
 * PlanLoop 运行器
 * @description 提供 Flow 与遗留策略图共用的流式运行和审批恢复入口；图构建细节收敛在 PlanGraphBuilder。
 */
@Injectable()
export class PlanGraphRunner {
  constructor(private readonly builder: PlanGraphBuilder) {}

  /**
   * 执行 PlanLoop
   * @param input 当前 AgentLoop 请求上下文
   * @param policy 锁定的 PlanLoop 运行策略
   * @returns 返回统一的 AgentLoop 事件流
   * @description Runner 只接收 PlanLoopPolicy，不感知 AgentStrategyMode、FlowVersion、HTTP 或 SSE 持久化。
   */
  stream(
    input: AgentLoopInput,
    policy: PlanLoopPolicy,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    return this.builder.stream(input, policy);
  }

  /**
   * 从计划或工具审批中断处恢复 PlanLoop
   * @param input 必须与首轮保持同一 task/thread 和能力装配的 AgentLoop 上下文
   * @param policy 首轮锁定的 PlanLoop 运行策略
   * @param decision 当前审批决定
   * @returns 返回恢复后的统一 AgentLoop 事件流
   * @description 恢复直接复用 Builder 的同形图与 checkpoint，不重新路由策略或解析 Flow 草稿。
   */
  resume(
    input: AgentLoopInput,
    policy: PlanLoopPolicy,
    decision: ApprovalDecision | PlanReviewDecision,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    return this.builder.resume(input, policy, decision);
  }
}
