import type { FlowNodeType } from "@litter-bear/types/agent-flow";

/**
 * 节点类型的类别配色
 * @description 语义色相只有 success/info/warning/danger/accent 五个，10 种节点类型
 * 不可能一型一色，按类别分配：模型计算（agent/plan/plan-loop/synthesize）用产品主色，
 * 控制流（condition/join/loop）用 info，人工节点（approval）用 warning，
 * start/end 用成功/中性。danger 刻意不分配给任何类型，专留校验错误态——
 * 否则「红色的节点」和「出错的节点」无法区分。
 */

export interface NodeTypeColor {
  /** 主色：图标颜色 */
  color: string;
  /** 同色 soft 底：图标 chip 背景 */
  soft: string;
}

const ACCENT: NodeTypeColor = {
  color: "var(--lb-accent)",
  soft: "var(--lb-accent-soft)",
};
const INFO: NodeTypeColor = {
  color: "var(--lb-info)",
  soft: "var(--lb-info-soft)",
};
const NEUTRAL: NodeTypeColor = {
  color: "var(--lb-text-secondary)",
  soft: "var(--lb-surface-muted)",
};

export const NODE_TYPE_COLORS: Record<FlowNodeType, NodeTypeColor> = {
  start: { color: "var(--lb-success)", soft: "var(--lb-success-soft)" },
  end: { color: "var(--lb-text-muted)", soft: "var(--lb-surface-muted)" },
  agent: ACCENT,
  plan: ACCENT,
  "plan-loop": ACCENT,
  synthesize: ACCENT,
  condition: INFO,
  join: INFO,
  loop: INFO,
  approval: { color: "var(--lb-warning)", soft: "var(--lb-warning-soft)" },
};

/** 读取节点类型的配色；未登记的类型回退中性色（与 nodeTypeMeta 的回退原则一致）。 */
export function nodeTypeColors(type: FlowNodeType): NodeTypeColor {
  return NODE_TYPE_COLORS[type] ?? NEUTRAL;
}
