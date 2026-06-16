import { Injectable } from '@nestjs/common';
import { AgentStrategyMode, type AgentStrategyGraph } from './agent-loop.types';
import { CommonReactGraph } from './graphs/common-react.graph';
import { DirectAnswerGraph } from './graphs/direct-answer.graph';
import { HybridPlanReactGraph } from './graphs/hybrid-plan-react.graph';
import { PlanExecuteGraph } from './graphs/plan-execute.graph';

@Injectable()
export class StrategyRegistryService {
  private readonly strategyRegistry: Record<
    AgentStrategyMode,
    AgentStrategyGraph
  >;

  constructor(
    directAnswerGraph: DirectAnswerGraph,
    commonReactGraph: CommonReactGraph,
    planExecuteGraph: PlanExecuteGraph,
    hybridPlanReactGraph: HybridPlanReactGraph,
  ) {
    this.strategyRegistry = {
      [AgentStrategyMode.Direct]: directAnswerGraph,
      [AgentStrategyMode.ReAct]: commonReactGraph,
      [AgentStrategyMode.PlanExecute]: planExecuteGraph,
      [AgentStrategyMode.Hybrid]: hybridPlanReactGraph,
    };
  }

  /**
   * 解析策略图
   * @param mode 策略模式
   * @returns 返回可执行的策略图
   * @description 通过白名单注册表获取策略实现，避免运行时动态拼装未知执行链路。
   */
  resolve(mode: AgentStrategyMode): AgentStrategyGraph {
    return this.strategyRegistry[mode];
  }
}
