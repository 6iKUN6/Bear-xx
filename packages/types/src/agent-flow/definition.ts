/**
 * AgentFlow Definition 当前支持的 JSON schema 版本。
 * @description 2 引入变量模型（`$ref`）、condition 分支与泛化的分支键；3 引入必需的 start 节点，
 * 并用它取代 `$input` 这个凭空存在的变量来源；4 把计划数据从隐式的全局状态改为显式 `$ref`
 * 传递，并给计划审批加上门禁策略；5 引入并行扇出与 join 节点。
 * schemaVersion 的职责就是「本工件符合第 N 版形状」，
 * 新增一个必需节点类型即形状变更，因此升版而不是原地改 2。
 * 不做双运行时：版本化工件的兼容成本会同时渗进 validator、compiler 与 workflow 三处，旧工件一律拒绝。
 */
export const AGENT_FLOW_SCHEMA_VERSION = 5 as const;

/** AgentFlow 支持的节点闭集。 */
export type FlowNodeType =
  | "start"
  | "agent"
  | "plan"
  | "plan-loop"
  | "approval"
  | "synthesize"
  | "condition"
  | "join";

/**
 * 变量可以承载的值类型闭集；不做泛型与嵌套类型参数
 * @description 刻意不含 `object`：当前没有任何节点声明对象输出，也没有任何 operator 接受对象，
 * 留着它就是一个既不产生也不消费的死类型。将来真有节点输出对象时再加，是一行的事。
 */
export type FlowValueType = "string" | "number" | "boolean" | "array";

/**
 * 一个结构化变量引用
 * @description 契约里只存结构化形式：编辑器可以让用户输入 `{{planner.steps}}`，但保存时必须
 * 解析成 `$ref` 落库。纯字符串模板无法可靠静态检查「被引节点存在 / 在上游 / 类型匹配」，
 * 那正是运行时冒出 undefined 的来源。
 * 元组是 `[节点标识, 输出字段名]`。用户本轮消息由 start 节点的 `text` 输出提供，
 * 因此这里不需要任何特殊来源标识——引用机制只有节点输出这一套。
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
  // start 的 text 就是用户本轮消息正文；它取代了原先的 `$input.text`
  start: { text: "string" },
  // 刻意不含 toolCalls：唯一的运行时来源是流事件，而 tool.call.start 的工具名可能缺失
  // （首个 chunk 尚未带名称），据此建数组会漏报已调用的工具——引用它的 notContains 会直接
  // 撒谎。需要这个输出时得先让底层流为每次调用给出稳定名称。
  agent: { text: "string" },
  plan: { steps: "array", stepCount: "number" },
  "plan-loop": { text: "string", observations: "array" },
  // approval 的 steps 是**确认或编辑后**的计划，可能与上游 plan 节点的不同；
  // 下游要执行「人确认过的那份」就引用它，要执行原始计划才引用 plan 节点
  approval: {
    approved: "boolean",
    comment: "string",
    steps: "array",
    stepCount: "number",
  },
  synthesize: { text: "string" },
  condition: {},
  // join 只做汇聚，不产出自己的值；下游要用某条分支的结果就直接引用那个节点
  join: {},
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
  /**
   * 要执行哪份计划
   * @description 指向任何带 `steps` 数组输出的上游节点：接 plan 即执行原始计划，
   * 接 approval 即执行人确认过的那份。此前这层关系是隐式的（全局只有一份计划），
   * 图上有两个 plan 节点时根本无法表达要执行哪个。
   */
  readonly planRef: FlowRef;
}

/**
 * 计划审批的门禁策略
 * @description `always` 每次都等人工确认；`never` 自动通过（保留节点与它的 steps 输出，
 * 便于按环境切换门禁而不用改图）；`model` 由模型判断这份计划是否值得人工过目。
 *
 * `model` **不是**安全边界：工具审批完全走另一条路（`CapabilityRegistry.requiresApproval`
 * 推导出 approvalToolNames，Flow JSON 没有降低工具风险等级的入口），不受本策略影响。
 * 这里判定的只是「要不要请人确认计划」这一层控制。
 * 且它必须**失败闭合**：模型不可用、输出非法或额度耗尽时一律按「需要人工确认」处理。
 */
export type FlowApprovalPolicy = "always" | "never" | "model";

/** 当前仅开放计划审批节点。 */
export interface FlowApprovalNodeConfig {
  readonly kind: "plan-review";
  readonly policy: FlowApprovalPolicy;
  /** 要审的是哪份计划；必须指向 plan 节点（重规划要用它的 maxSteps） */
  readonly planRef: FlowRef;
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

/**
 * Join 节点配置
 * @description `waitFor` 列出要等待的节点标识，`policy` 决定等多少个：
 * `all` 全部完成才继续，`any` 任一完成即继续。
 *
 * fan-in 必须显式声明而不做隐式汇聚：条件分支 + 隐式 join = 等一个永远不会到达的分支 = 死锁。
 * 做成显式节点后，「会不会等一个不可能完成的分支」在发布期就能判定。
 *
 * `any` 语义下**不取消**未完成的分支：取消会打乱预算计数与事件序，而让它们跑完的代价只是
 * 一点额度。它们的结果不进入下游——下游能引用的只有 join 保证已完成的那部分。
 */
export interface FlowJoinNodeConfig {
  readonly waitFor: readonly string[];
  readonly policy: "all" | "any";
}

/** Condition 节点配置；`else` 分支隐含存在，不需要声明。 */
export interface FlowConditionNodeConfig {
  readonly cases: readonly FlowConditionCase[];
}

/**
 * 所有节点共有的字段
 * @description `id` 与 `name` 职责分开：`id` 是机器标识，被 edges 的 from/to、`$ref` 的第一个
 * 元素和 layout 的键引用，改它等于改引用；`name` 只影响画布与列表的显示，随便改都不会断链，
 * 也可以用中文。缺省时界面回退显示 `id`。
 * `name` 参与 digest——顶层 layout 被排除是因为坐标是拖动的副产物，而改名是刻意的编辑动作，
 * 工件确实变了。
 */
export interface FlowNodeBase {
  readonly id: string;
  readonly name?: string;
}

/**
 * 所有节点共有的字段
 * @description `id` 与 `name` 职责分开：`id` 是机器标识，被 edges 的 from/to、`$ref` 的第一个
 * 元素和 layout 的键引用，改它等于改引用；`name` 只影响画布与列表的显示，随便改都不会断链，
 * 也可以用中文。缺省时界面回退显示 `id`。
 * `name` 参与 digest——顶层 layout 被排除是因为坐标是拖动的副产物，而改名是刻意的编辑动作，
 * 工件确实变了。
 */
export interface FlowNodeBase {
  readonly id: string;
  readonly name?: string;
}

/** Agent 节点。 */
export interface FlowAgentNode extends FlowNodeBase {
  readonly type: "agent";
  readonly config: FlowAgentNodeConfig;
}

/** Plan 节点。 */
export interface FlowPlanNode extends FlowNodeBase {
  readonly type: "plan";
  readonly config: FlowPlanNodeConfig;
}

/** PlanLoop 节点。 */
export interface FlowPlanLoopNode extends FlowNodeBase {
  readonly type: "plan-loop";
  readonly config: FlowPlanLoopNodeConfig;
}

/** 计划审批节点。 */
export interface FlowApprovalNode extends FlowNodeBase {
  readonly type: "approval";
  readonly config: FlowApprovalNodeConfig;
}

/** 汇总节点配置。 */
export interface FlowSynthesizeNodeConfig {
  /**
   * 要汇总谁的步骤观察
   * @description 可选：缺省时退化为不带工具的普通汇总（保留原有语义），有值时读取被引节点的
   * `observations` 数组作为汇总素材。
   */
  readonly observationsRef?: FlowRef;
}

/** 汇总节点。 */
export interface FlowSynthesizeNode extends FlowNodeBase {
  readonly type: "synthesize";
  readonly config: FlowSynthesizeNodeConfig;
}

/** 汇聚节点；等待并行分支后继续。 */
export interface FlowJoinNode extends FlowNodeBase {
  readonly type: "join";
  readonly config: FlowJoinNodeConfig;
}

/** 起始节点；每张图有且仅有一个，是唯一入口，并提供用户本轮消息。 */
export interface FlowStartNode extends FlowNodeBase {
  readonly type: "start";
  readonly config: Record<string, never>;
}

/** 条件分支节点。 */
export interface FlowConditionNode extends FlowNodeBase {
  readonly type: "condition";
  readonly config: FlowConditionNodeConfig;
}

/** Flow 节点判别联合。 */
export type FlowNode =
  | FlowStartNode
  | FlowAgentNode
  | FlowPlanNode
  | FlowPlanLoopNode
  | FlowApprovalNode
  | FlowSynthesizeNode
  | FlowConditionNode
  | FlowJoinNode;

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
  | "blank"
  | "direct"
  | "react"
  | "plan_execute"
  | "hybrid";

/**
 * 计算每个节点执行前「必定已完成」的节点集合
 * @param nodes 图中全部节点
 * @param edges 图中全部边（只需要端点）
 * @returns 返回节点标识到其前置必完成集合的映射（含节点自身）；入口不唯一时返回空映射
 * @description 这不是教科书意义上的支配集。支配集假设「多条出边只走一条」，那对 condition
 * 成立、对并行扇出不成立——扇出的多条 default 边**全都会走**。于是分三种传播：
 *
 * - 普通节点：对所有前驱求**交集**。同时正确处理两种情形：condition 的互斥分支（只走一条，
 *   交集排除掉未走的那条），以及扇出之后、汇聚之前的节点（不能引用兄弟分支的输出，因为那条
 *   分支可能还没跑完——并发不等于已完成）。
 * - `join` + `policy: "all"`：对 waitFor 求**并集**。全部分支都必须完成才继续，因此它们各自
 *   的前置也都有保证。这是支配集算不出来的部分：图上看是多条路径汇聚，实际上都走过。
 * - `join` + `policy: "any"`：对 waitFor 求**交集**。只有公共前置有保证，某条分支可能没跑完。
 *
 * 后端 validator 用它判定 ref-dominates，管理端画布用它决定变量选择器能列出哪些上游输出。
 * 两处必须给出同一个答案，因此实现只有这一份。
 *
 * 只对入口可达的节点求解；入口不唯一时返回空映射，让调用方给不出结论而不是给出错的结论。
 */
export function flowMustCompleteBefore(
  nodes: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly config?: unknown;
  }>,
  edges: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): Map<string, ReadonlySet<string>> {
  const incoming = new Set(edges.map((edge) => edge.to));
  const entries = nodes.filter((node) => !incoming.has(node.id));
  if (entries.length !== 1) {
    return new Map();
  }
  const entryId = entries[0].id;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    predecessors.set(edge.to, [...(predecessors.get(edge.to) ?? []), edge.from]);
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
  }

  const reachable = new Set<string>();
  const pending = [entryId];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || reachable.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    pending.push(...(successors.get(nodeId) ?? []));
  }

  const result = new Map<string, Set<string>>();
  for (const nodeId of reachable) {
    // 初值取全集：交集迭代必须从上界开始才能单调收缩到不动点。并集分支不受影响，
    // 因为它每轮都整体重算。
    result.set(
      nodeId,
      nodeId === entryId ? new Set([entryId]) : new Set(reachable),
    );
  }

  const sourcesOf = (nodeId: string): string[] => {
    const waitFor = readJoinWaitFor(nodesById.get(nodeId));
    if (waitFor) {
      return waitFor.filter((item) => reachable.has(item));
    }
    return (predecessors.get(nodeId) ?? []).filter((item) =>
      reachable.has(item),
    );
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of reachable) {
      if (nodeId === entryId) {
        continue;
      }
      const node = nodesById.get(nodeId);
      const sources = sourcesOf(nodeId);
      const next = new Set<string>();
      if (sources.length > 0) {
        const contribution = (source: string): ReadonlySet<string> =>
          new Set([...(result.get(source) ?? []), source]);
        if (readJoinWaitFor(node) && readJoinPolicy(node) === "all") {
          for (const source of sources) {
            for (const item of contribution(source)) {
              next.add(item);
            }
          }
        } else {
          for (const item of contribution(sources[0])) {
            next.add(item);
          }
          for (const source of sources.slice(1)) {
            const other = contribution(source);
            for (const item of [...next]) {
              if (!other.has(item)) {
                next.delete(item);
              }
            }
          }
        }
      }
      next.add(nodeId);

      const current = result.get(nodeId);
      if (!current || current.size !== next.size) {
        result.set(nodeId, next);
        changed = true;
        continue;
      }
      for (const item of next) {
        if (!current.has(item)) {
          result.set(nodeId, next);
          changed = true;
          break;
        }
      }
    }
  }
  return new Map(result);
}

/**
 * 读取 join 节点的 waitFor
 * @param node 待判定节点
 * @returns 是 join 且 waitFor 形状合法时返回它，否则返回 undefined
 * @description 参数只声明本分析真正读到的字段（id / type / config），因此管理端那种「config 尚未
 * 校验」的草稿也能直接传进来，不必先断言成完整 FlowNode。形状不符时按普通节点处理——
 * 那种图本来就会被 join-wait-for 规则拒掉，这里不需要再多一种失败模式。
 */
function readJoinWaitFor(
  node: { readonly type: string; readonly config?: unknown } | undefined,
): readonly string[] | undefined {
  if (node?.type !== "join") {
    return undefined;
  }
  const waitFor = (node.config as { waitFor?: unknown } | undefined)?.waitFor;
  return Array.isArray(waitFor) &&
    waitFor.every((item) => typeof item === "string")
    ? (waitFor as readonly string[])
    : undefined;
}

/**
 * 读取 join 节点的等待策略
 * @param node 待判定节点
 * @returns 只有显式声明为 all 时返回 "all"，其余一律按 "any" 处理
 * @description 缺省到 any 是有意的**保守**选择。all 会让分析对分支求并集、给出「这些分支都
 * 必定完成」的强保证；若实际策略是 any 或形状读不出来，那就是把没保证的说成有保证，下游
 * 引用它会在运行时取到空值。反过来缺省到 any 只会少给保证，用户最多是发布时被拒。
 */
function readJoinPolicy(
  node: { readonly type: string; readonly config?: unknown } | undefined,
): "all" | "any" {
  const policy = (node?.config as { policy?: unknown } | undefined)?.policy;
  return policy === "all" ? "all" : "any";
}
