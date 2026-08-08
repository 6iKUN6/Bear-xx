/**
 * Agent 执行策略闭集
 *
 * 放在协议层而非 apps/api：策略标识已经跨线传输——`strategy.selected` 的 `mode`
 * 与 `workflow.step.*` 的 `strategy` 都会下发给前端展示。此前前端只能按裸字符串
 * 拼「策略 ${mode}」，无法校验取值也没有中文名。
 *
 * 执行侧的策略解析（注册表 / 路由 / 能力装配）仍留在 apps/api，本文件只定义标识与文案。
 */

/** 执行策略 */
export enum AgentStrategyMode {
  /** 直答：不装载工具，模型单次生成 */
  Direct = 'direct',
  /** ReAct：模型按需调用工具，边想边做 */
  ReAct = 'react',
  /** 计划-执行：先拆解步骤再逐步执行，跑完全部步骤后综合 */
  PlanExecute = 'plan_execute',
  /** 混合：规划后逐步执行，每步评估信息是否足够以提前收尾 */
  Hybrid = 'hybrid',
}

/**
 * 策略 → 中文展示名
 * @description 用 Record 保证新增策略时必须补文案（编译期穷尽校验，漏一个即报错）。
 */
export const AGENT_STRATEGY_LABELS: Record<AgentStrategyMode, string> = {
  [AgentStrategyMode.Direct]: '直接回答',
  [AgentStrategyMode.ReAct]: '边想边做',
  [AgentStrategyMode.PlanExecute]: '计划执行',
  [AgentStrategyMode.Hybrid]: '动态规划',
};

/**
 * 获取策略的中文展示名
 * @param mode 策略标识
 * @returns 返回中文名；未知取值回退为原始标识
 */
export function getAgentStrategyLabel(mode: AgentStrategyMode): string {
  return AGENT_STRATEGY_LABELS[mode] ?? mode;
}
