import { AgentStrategyMode } from '../../agent-loop.types';
import type { PlanLoopPolicy } from './plan-loop-policy';

/** PlanLoop 历史 SSE 协议仍需使用的策略标识。 */
export type LegacyPlanLoopStrategy =
  AgentStrategyMode.PlanExecute | AgentStrategyMode.Hybrid;

/**
 * 从 PlanLoopPolicy 派生历史策略展示标识
 * @param policy 受限的 PlanLoop 运行策略
 * @returns 返回现有 workflow.step.* 事件所需的策略标识
 * @description 这只是旧 SSE 协议的投影，不参与执行分支；新 Flow 节点事件将在后续阶段替代该字段。
 */
export function toLegacyPlanLoopStrategy(
  policy: PlanLoopPolicy,
): LegacyPlanLoopStrategy {
  return policy.stopPolicy === 'evaluate-after-step'
    ? AgentStrategyMode.Hybrid
    : AgentStrategyMode.PlanExecute;
}
