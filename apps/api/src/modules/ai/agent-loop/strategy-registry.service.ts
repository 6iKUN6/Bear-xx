import { Injectable } from '@nestjs/common';
import { AgentStrategyMode, type AgentStrategyGraph } from './agent-loop.types';
import { CommonReactGraph } from './graphs/common-react.graph';
import { DirectAnswerGraph } from './graphs/direct-answer.graph';
import { HybridPlanReactGraph } from './graphs/hybrid-plan-react.graph';
import { PlanExecuteGraph } from './graphs/plan-execute.graph';

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
