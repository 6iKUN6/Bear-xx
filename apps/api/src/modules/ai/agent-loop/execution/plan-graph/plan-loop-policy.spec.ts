import { AgentStrategyMode } from '../../agent-loop.types';
import {
  HYBRID_PLAN_LOOP_POLICY,
  PLAN_EXECUTE_LOOP_POLICY,
  resolvePlanLoopPolicy,
} from './plan-loop-policy';

describe('PlanLoopPolicy', () => {
  it('将旧 PlanExecute 和 Hybrid 策略映射为固定循环策略', () => {
    expect(resolvePlanLoopPolicy(AgentStrategyMode.PlanExecute)).toEqual(
      PLAN_EXECUTE_LOOP_POLICY,
    );
    expect(resolvePlanLoopPolicy(AgentStrategyMode.Hybrid)).toEqual(
      HYBRID_PLAN_LOOP_POLICY,
    );
  });

  it('拒绝非计划类旧策略进入 PlanLoop', () => {
    expect(() => resolvePlanLoopPolicy(AgentStrategyMode.Direct)).toThrow(
      '不支持 PlanLoop',
    );
  });
});
