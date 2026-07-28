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

  /**
   * 列出已安装的策略模式
   * @returns 返回注册表中已实现并可执行的策略模式列表
   * @description 作为"已安装策略闭集"的单一事实源，供 agent 配置校验 allowedStrategies/defaultStrategy。
   * ToT/LATS 等未来策略图注册进来后自动出现在此列表。
   */
  listInstalledStrategies(): AgentStrategyMode[] {
    return Object.keys(this.strategyRegistry) as AgentStrategyMode[];
  }
}
