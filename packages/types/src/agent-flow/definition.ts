/** AgentFlow Definition 当前支持的 JSON schema 版本。 */
export const AGENT_FLOW_SCHEMA_VERSION = 1 as const;

/** AgentFlow V1 支持的节点闭集。 */
export type FlowNodeType =
  "agent" | "plan" | "plan-loop" | "approval" | "synthesize";

/** Flow 的运行预算策略。 */
export interface FlowPolicy {
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxDurationSeconds: number;
}

/** Agent 节点的受限执行器配置。 */
export interface FlowAgentNodeConfig {
  /** 缺省时继承任务锁定的 Agent 默认模型。 */
  readonly modelPreset?: string;
  readonly toolGroups: readonly string[];
  readonly skills: readonly string[];
  readonly maxToolIterations: number;
}

/** Plan 节点配置。 */
export interface FlowPlanNodeConfig {
  readonly maxSteps: number;
}

/** PlanLoop 内部 Agent 执行器配置。 */
export interface FlowPlanLoopExecutorConfig extends FlowAgentNodeConfig {
  readonly type: "agent";
}

/** PlanLoop 的受控停止策略。 */
export type FlowPlanLoopStopPolicy = "all-steps" | "evaluate-after-step";

/** PlanLoop 节点配置。 */
export interface FlowPlanLoopNodeConfig {
  readonly executor: FlowPlanLoopExecutorConfig;
  readonly stopPolicy: FlowPlanLoopStopPolicy;
}

/** V1 仅开放计划审批节点。 */
export interface FlowApprovalNodeConfig {
  readonly kind: "plan-review";
}

/** Agent 节点。 */
export interface FlowAgentNode {
  readonly id: string;
  readonly type: "agent";
  readonly config: FlowAgentNodeConfig;
}

/** Plan 节点。 */
export interface FlowPlanNode {
  readonly id: string;
  readonly type: "plan";
  readonly config: FlowPlanNodeConfig;
}

/** PlanLoop 节点。 */
export interface FlowPlanLoopNode {
  readonly id: string;
  readonly type: "plan-loop";
  readonly config: FlowPlanLoopNodeConfig;
}

/** 计划审批节点。 */
export interface FlowApprovalNode {
  readonly id: string;
  readonly type: "approval";
  readonly config: FlowApprovalNodeConfig;
}

/** 汇总节点。 */
export interface FlowSynthesizeNode {
  readonly id: string;
  readonly type: "synthesize";
  readonly config: Record<string, never>;
}

/** Flow 节点判别联合。 */
export type FlowNode =
  | FlowAgentNode
  | FlowPlanNode
  | FlowPlanLoopNode
  | FlowApprovalNode
  | FlowSynthesizeNode;

/** 审批节点可声明的有限分支。 */
export type FlowEdgeWhen = "approved";

/** Flow 节点间的有向边。 */
export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly when?: FlowEdgeWhen;
}

/** 画布节点的位置，仅供编辑器展示，不参与运行或 digest。 */
export interface FlowNodeLayout {
  readonly x: number;
  readonly y: number;
}

/** Flow 编辑器画布状态。 */
export interface FlowLayout {
  readonly nodes: Readonly<Record<string, FlowNodeLayout>>;
}

/** 可导入、导出和发布的 AgentFlow JSON 工件。 */
export interface FlowDefinition {
  readonly schemaVersion: typeof AGENT_FLOW_SCHEMA_VERSION;
  readonly kind: "agent-flow";
  readonly name: string;
  readonly description?: string;
  readonly policy: FlowPolicy;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly layout?: FlowLayout;
}

/** 内置 Flow 预设名称。 */
export type FlowDefinitionPreset =
  "direct" | "react" | "plan_execute" | "hybrid";
