import { AgentStrategyMode } from '../../agent-loop.types';

/** PlanLoop 的受限停止策略。 */
export interface PlanLoopPolicy {
  /** 全部步骤执行完毕，或每步后由评估器决定是否提前结束。 */
  stopPolicy: 'all-steps' | 'evaluate-after-step';
  /** 是否在计划生成后等待人工确认。 */
  planReview: 'required' | 'disabled';
  /** 本轮最多执行的计划步骤数。 */
  maxSteps: number;
}

/** 旧 PlanExecute 图的兼容策略映射。 */
export const PLAN_EXECUTE_LOOP_POLICY: PlanLoopPolicy = {
  stopPolicy: 'all-steps',
  planReview: 'required',
  maxSteps: 6,
};

/** 旧 Hybrid 图的兼容策略映射。 */
export const HYBRID_PLAN_LOOP_POLICY: PlanLoopPolicy = {
  stopPolicy: 'evaluate-after-step',
  planReview: 'disabled',
  maxSteps: 6,
};

/**
 * 将遗留策略映射为 PlanLoopPolicy
 * @param strategy 旧策略图的模式标识
 * @returns 返回与旧图行为等价的 PlanLoopPolicy
 * @description 仅作为阶段性薄适配；PlanGraphRunner 的核心执行路径只消费 PlanLoopPolicy，不再依赖策略枚举。
 */
export function resolvePlanLoopPolicy(
  strategy: AgentStrategyMode,
  maxSteps = PLAN_EXECUTE_LOOP_POLICY.maxSteps,
): PlanLoopPolicy {
  switch (strategy) {
    case AgentStrategyMode.PlanExecute:
      return { ...PLAN_EXECUTE_LOOP_POLICY, maxSteps };
    case AgentStrategyMode.Hybrid:
      return { ...HYBRID_PLAN_LOOP_POLICY, maxSteps };
    default:
      throw new Error(`策略 ${strategy} 不支持 PlanLoop`);
  }
}
