/**
 * AgentFlow Definition 当前支持的 JSON schema 版本。
 * @description 2 引入变量模型（`$ref`）、condition 分支与泛化的分支键。不做双运行时：
 * 版本化工件的兼容成本会同时渗进 validator、compiler 与 workflow 三处，V1 工件一律拒绝。
 */
export const AGENT_FLOW_SCHEMA_VERSION = 2 as const;

/** AgentFlow 支持的节点闭集。 */
export type FlowNodeType =
  | "agent"
  | "plan"
  | "plan-loop"
  | "approval"
  | "synthesize"
  | "condition";

/**
 * 变量可以承载的值类型闭集；不做泛型与嵌套类型参数
 * @description 刻意不含 `object`：当前没有任何节点声明对象输出，也没有任何 operator 接受对象，
 * 留着它就是一个既不产生也不消费的死类型。将来真有节点输出对象时再加，是一行的事。
 */
export type FlowValueType = "string" | "number" | "boolean" | "array";

/** Flow 级根变量的来源标识，语法上占据一个节点位。 */
export const FLOW_INPUT_SOURCE = "$input" as const;

/**
 * 一个结构化变量引用
 * @description 契约里只存结构化形式：编辑器可以让用户输入 `{{planner.steps}}`，但保存时必须
 * 解析成 `$ref` 落库。纯字符串模板无法可靠静态检查「被引节点存在 / 在上游 / 类型匹配」，
 * 那正是运行时冒出 undefined 的来源。
 * 元组是 `[节点标识 | "$input", 输出字段名]`。
 */
export interface FlowRef {
  readonly $ref: readonly [string, string];
}

/**
 * 各节点类型声明的输出闭集
 * @description 输出由代码声明，用户不能新增：这样编辑器的变量选择器和 validator 的类型检查
 * 用的是同一份事实，不会漂移。condition 只产分支、不产输出。
 */
export const FLOW_NODE_OUTPUTS: Readonly<
  Record<FlowNodeType, Readonly<Record<string, FlowValueType>>>
> = {
  // 刻意不含 toolCalls：唯一的运行时来源是流事件，而 tool.call.start 的工具名可能缺失
  // （首个 chunk 尚未带名称），据此建数组会漏报已调用的工具——引用它的 notContains 会直接
  // 撒谎。需要这个输出时得先让底层流为每次调用给出稳定名称。
  agent: { text: "string" },
  plan: { steps: "array", stepCount: "number" },
  "plan-loop": { text: "string", observations: "array" },
  approval: { approved: "boolean", comment: "string" },
  synthesize: { text: "string" },
  condition: {},
};

/**
 * Flow 级根变量的输出闭集
 * @description 只有 `text`（用户本轮消息正文）。设计初稿还列了 `attachments`，但任务载荷
 * （ChatTaskPayload）里没有这个字段，声明出来就是一个永远为空的输出——引用它的条件永远判 false，
 * 属于「永远算不对」的那类坑。真接入附件时再加。
 */
export const FLOW_INPUT_OUTPUTS: Readonly<Record<string, FlowValueType>> = {
  text: "string",
};

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

/** 当前仅开放计划审批节点。 */
export interface FlowApprovalNodeConfig {
  readonly kind: "plan-review";
}

/** 条件判定的算子闭集。 */
export type FlowConditionOperator =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "empty"
  | "notEmpty"
  | "eq"
  | "ne"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "isTrue"
  | "isFalse"
  | "lengthEq";

/**
 * 每个算子接受的被引变量类型与是否需要比较值
 * @description `requiresValue` 是必须的一维：`empty` 这类算子不带值，而 `is` 缺了值就会去和
 * undefined 比较——静默判 false，是旧 condition stub 那类「永远算不对」的错误。
 * 校验期用它同时拦「算子与类型不匹配」和「该带值却没带」。
 */
export const FLOW_CONDITION_OPERATORS: Readonly<
  Record<
    FlowConditionOperator,
    {
      readonly valueTypes: readonly FlowValueType[];
      readonly requiresValue: boolean;
    }
  >
> = {
  is: { valueTypes: ["string"], requiresValue: true },
  isNot: { valueTypes: ["string"], requiresValue: true },
  contains: { valueTypes: ["string", "array"], requiresValue: true },
  notContains: { valueTypes: ["string", "array"], requiresValue: true },
  startsWith: { valueTypes: ["string"], requiresValue: true },
  endsWith: { valueTypes: ["string"], requiresValue: true },
  empty: { valueTypes: ["string", "array"], requiresValue: false },
  notEmpty: { valueTypes: ["string", "array"], requiresValue: false },
  eq: { valueTypes: ["number"], requiresValue: true },
  ne: { valueTypes: ["number"], requiresValue: true },
  gt: { valueTypes: ["number"], requiresValue: true },
  lt: { valueTypes: ["number"], requiresValue: true },
  gte: { valueTypes: ["number"], requiresValue: true },
  lte: { valueTypes: ["number"], requiresValue: true },
  isTrue: { valueTypes: ["boolean"], requiresValue: false },
  isFalse: { valueTypes: ["boolean"], requiresValue: false },
  lengthEq: { valueTypes: ["array"], requiresValue: true },
};

/** 单条条件判定。 */
export interface FlowConditionPredicate {
  readonly ref: FlowRef;
  readonly operator: FlowConditionOperator;
  readonly value?: string | number | boolean;
}

/** 一个命名条件分支；同一节点内 key 唯一。 */
export interface FlowConditionCase {
  readonly key: string;
  readonly logic: "and" | "or";
  readonly conditions: readonly FlowConditionPredicate[];
}

/** Condition 节点配置；`else` 分支隐含存在，不需要声明。 */
export interface FlowConditionNodeConfig {
  readonly cases: readonly FlowConditionCase[];
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

/** 条件分支节点。 */
export interface FlowConditionNode {
  readonly id: string;
  readonly type: "condition";
  readonly config: FlowConditionNodeConfig;
}

/** Flow 节点判别联合。 */
export type FlowNode =
  | FlowAgentNode
  | FlowPlanNode
  | FlowPlanLoopNode
  | FlowApprovalNode
  | FlowSynthesizeNode
  | FlowConditionNode;

/**
 * 边上的分支键
 * @description 从 V1 的单值联合 `"approved"` 泛化为字符串：合法取值不再由类型系统枚举，
 * 而是由源节点声明的分支键集合（见 flowNodeBranchKeys）在校验期判定。
 */
export type FlowEdgeWhen = string;

/** 非分支节点唯一的出边分支键；边上 `when` 缺省即代表它。 */
export const FLOW_DEFAULT_BRANCH = "default" as const;

/** Condition 节点未命中任何 case 时走的隐含分支。 */
export const FLOW_CONDITION_ELSE_BRANCH = "else" as const;

/**
 * 列出一个节点声明的全部分支键
 * @param node 目标节点
 * @returns 返回该节点合法出边分支键的有序集合
 * @description validator、运行时快照与管理端画布共用这一份事实，避免三处各写一份分支规则后漂移。
 */
export function flowNodeBranchKeys(node: FlowNode): readonly string[] {
  if (node.type === "condition") {
    return [
      ...node.config.cases.map((item) => item.key),
      FLOW_CONDITION_ELSE_BRANCH,
    ];
  }
  // approval 暂时只有 approved：设计初稿想把「拒绝」也补成真分支，但当前没有任何节点类型
  // 能作为它的落点（需要一个"以固定文案终止"的终端节点），而运行时已经把 reject_terminate
  // 正确处理成业务终态。现在声明 rejected 只会多一个无处可去的分支键。
  if (node.type === "approval") {
    return ["approved"];
  }
  return [FLOW_DEFAULT_BRANCH];
}

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
