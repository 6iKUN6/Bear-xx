import type { AgentStrategy } from "@/api/types";

/**
 * 策略编排的中文元数据（闭集）。
 * 后续新增编排（如 TOT / LATS）时在此追加一项即可，表单与列表自动生效。
 */
export interface StrategyMeta {
  value: AgentStrategy;
  name: string;
  desc: string;
}

export const STRATEGY_OPTIONS: StrategyMeta[] = [
  {
    value: "AUTO",
    name: "自动路由",
    desc: "按问题复杂度与所需能力，自动挑选下面最合适的编排",
  },
  {
    value: "DIRECT",
    name: "直接回答",
    desc: "单次模型调用直接作答，不调用工具，响应最快",
  },
  {
    value: "REACT",
    name: "推理行动 ReAct",
    desc: "边推理边调用工具，循环「思考 → 行动 → 观察」直到得出答案",
  },
  {
    value: "PLAN_EXECUTE",
    name: "计划执行",
    desc: "先把任务拆解成完整计划，逐步执行全部步骤后综合输出",
  },
  {
    value: "HYBRID",
    name: "混合编排",
    desc: "规划后逐步执行，每步动态评估信息是否已足够并提前收尾",
  },
];

const strategyMetaByValue = new Map(
  STRATEGY_OPTIONS.map((s) => [s.value, s]),
);

/** 策略中文名；未知值回退原始枚举串 */
export function strategyName(value: string): string {
  return strategyMetaByValue.get(value as AgentStrategy)?.name ?? value;
}

/** 工具组中文展示（组名来自后端能力闭集，未登记的组回退原名） */
export const TOOL_GROUP_META: Record<string, { name: string; desc: string }> = {
  default: { name: "基础全集", desc: "包含当前全部基础工具" },
  weather: { name: "天气查询", desc: "查询城市实时天气（执行前需人工审批）" },
  search: { name: "联网搜索", desc: "Tavily 联网检索实时信息" },
};

export function toolGroupName(group: string): string {
  return TOOL_GROUP_META[group]?.name ?? group;
}
