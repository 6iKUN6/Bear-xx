import {
  Bot,
  FileText,
  GitBranch,
  ListChecks,
  Play,
  Repeat,
  Merge,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import {
  FLOW_CONDITION_ELSE_BRANCH,
  FLOW_DEFAULT_BRANCH,
  FLOW_NODE_OUTPUTS,
  flowMustCompleteBefore,
  flowNodeBranchKeys,
  type FlowEdge,
  type FlowNode,
  type FlowNodeType,
} from "@litter-bear/types/agent-flow";

/** 画布节点坐标。 */
export interface FlowNodePosition {
  x: number;
  y: number;
}

/**
 * 画布投影真正需要的最小结构
 * @description 刻意不声明成 `FlowDefinition`：草稿可能还没通过服务端校验，把它断言成合法
 * Definition 是在撒谎。这里只声明 readDefinitionForCanvas 确实逐项检查过的字段——节点标识、
 * 闭集内的类型、边的端点、坐标。`config` 保持 unknown，由各节点的 inspector 自己收窄。
 */
export interface CanvasDefinition {
  nodes: ReadonlyArray<{
    id: string;
    name?: string;
    type: FlowNodeType;
    config: unknown;
  }>;
  edges: ReadonlyArray<{ from: string; to: string; when?: string }>;
  layout?: { nodes?: Readonly<Record<string, FlowNodePosition>> };
}

/**
 * 画布用的节点视图
 * @description position 来自 Definition 的 layout；layout 缺失时按拓扑层次补默认坐标。
 */
export interface FlowGraphNode {
  id: string;
  /** 显示名；缺省时调用方回退显示 id */
  name?: string;
  type: FlowNodeType;
  position: FlowNodePosition;
  config: unknown;
}

/** 画布用的边视图；label 是展示用的分支键中文名。 */
export interface FlowGraphEdge {
  id: string;
  source: string;
  target: string;
  branch: string;
  label: string;
}

/** 一次 Definition 投影结果。 */
export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

/** 后台已知的节点类型；从共享契约的输出声明派生，不另写一份清单。 */
const KNOWN_NODE_TYPES = new Set<string>(Object.keys(FLOW_NODE_OUTPUTS));

/** 投影前提检查结果；失败时带上可直接展示给用户的原因。 */
export type CanvasDefinitionResult =
  { ok: true; definition: CanvasDefinition } | { ok: false; reason: string };

/**
 * 检查一份 Definition 能否画出来
 * @param definition 服务端返回的 Definition 工件
 * @returns 可投影时返回收窄后的结构，否则返回中文原因
 * @description 这是**投影前提**，不是结构校验：合法性由服务端校验器唯一裁定，前端再抄一份
 * 规则必然与后端漂移。这里只回答「画布能不能把它摆出来」——节点有标识、类型在共享契约的
 * 闭集内、边的端点是字符串。因此草稿里 config 写错仍能画，正是编辑中需要的；而节点类型是
 * 后端新加的、后台还不认识时明确说不出来，不画一个空画布让人以为 Flow 是空的。
 */
export function readDefinitionForCanvas(
  definition: object,
): CanvasDefinitionResult {
  const source = definition as {
    nodes?: unknown;
    edges?: unknown;
    layout?: unknown;
  };
  if (!Array.isArray(source.nodes) || !Array.isArray(source.edges)) {
    return { ok: false, reason: "Definition 缺少 nodes 或 edges 数组" };
  }

  const nodes: Array<{
    id: string;
    name?: string;
    type: FlowNodeType;
    config: unknown;
  }> = [];
  for (const item of source.nodes) {
    const candidate = item as {
      id?: unknown;
      name?: unknown;
      type?: unknown;
      config?: unknown;
    };
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.type !== "string"
    ) {
      return { ok: false, reason: "存在缺少 id 或 type 的节点" };
    }
    if (!KNOWN_NODE_TYPES.has(candidate.type)) {
      return {
        ok: false,
        reason: `节点「${candidate.id}」的类型「${candidate.type}」不在后台已知的节点闭集内，请更新后台版本`,
      };
    }
    nodes.push({
      id: candidate.id,
      ...(typeof candidate.name === "string" && candidate.name
        ? { name: candidate.name }
        : {}),
      // 上一行已确认它落在 FLOW_NODE_OUTPUTS 的键集合内，即 FlowNodeType
      type: candidate.type as FlowNodeType,
      config: candidate.config,
    });
  }

  const edges: Array<{ from: string; to: string; when?: string }> = [];
  for (const item of source.edges) {
    const candidate = item as { from?: unknown; to?: unknown; when?: unknown };
    if (
      typeof candidate.from !== "string" ||
      typeof candidate.to !== "string"
    ) {
      return { ok: false, reason: "存在缺少 from 或 to 的边" };
    }
    edges.push({
      from: candidate.from,
      to: candidate.to,
      ...(typeof candidate.when === "string" ? { when: candidate.when } : {}),
    });
  }

  return {
    ok: true,
    definition: { nodes, edges, ...readLayout(source.layout) },
  };
}

/**
 * 读取画布坐标
 * @param value Definition 的 layout 字段
 * @returns 坐标合法的部分；整体缺失或形状异常时返回空
 * @description 坐标只影响观感，读不到就走自动排布，不因此拒绝渲染整张图。
 */
function readLayout(value: unknown): Pick<CanvasDefinition, "layout"> {
  const nodes = (value as { nodes?: unknown } | undefined)?.nodes;
  if (typeof nodes !== "object" || nodes === null) {
    return {};
  }
  const positions: Record<string, FlowNodePosition> = {};
  for (const [nodeId, position] of Object.entries(nodes)) {
    const candidate = position as { x?: unknown; y?: unknown };
    if (typeof candidate.x === "number" && typeof candidate.y === "number") {
      positions[nodeId] = { x: candidate.x, y: candidate.y };
    }
  }
  return { layout: { nodes: positions } };
}

/**
 * 节点类型的图标
 * @description 与 NODE_TYPE_META 并列而不是塞进同一个对象：meta 是纯数据、被投影层与
 * 校验提示复用，图标只服务于展示层。混在一起会让纯数据模块依赖图标库。
 */
export const NODE_TYPE_ICONS: Record<FlowNodeType, LucideIcon> = {
  start: Play,
  agent: Bot,
  plan: ListChecks,
  "plan-loop": Repeat,
  approval: UserCheck,
  synthesize: FileText,
  condition: GitBranch,
  join: Merge,
};

/** 节点类型的展示元数据；`type` 是契约里的英文类型名，与节点标识是两回事。 */
interface NodeTypeMeta {
  name: string;
  /** 契约中的类型名；界面上与中文名并列展示 */
  type: string;
  desc: string;
}

/**
 * 节点类型的中文展示元数据
 * @description 每一项都带上英文类型名。界面上只显示中文会让人把**节点标识**和**节点类型**
 * 搞混：模板里那个叫 `answer` 的节点在 plan_execute 里是 synthesize 类型、在 direct 里却是
 * agent 类型，只看到「汇总回复」和「answer」两个词，会以为它们是两个重复的东西。
 */
const NODE_TYPE_META: Record<FlowNodeType, NodeTypeMeta> = {
  start: {
    name: "开始",
    type: "start",
    desc: "流程入口；输出用户本轮消息，供下游引用",
  },
  agent: {
    name: "智能体",
    type: "agent",
    desc: "按配置的工具组与技能执行一轮对话",
  },
  plan: {
    name: "生成计划",
    type: "plan",
    desc: "调用规划器产出可执行步骤",
  },
  "plan-loop": {
    name: "执行计划",
    type: "plan-loop",
    desc: "逐步执行计划，循环在节点内部",
  },
  approval: {
    name: "计划确认",
    type: "approval",
    desc: "等待人工确认或修改计划",
  },
  synthesize: {
    name: "汇总回复",
    type: "synthesize",
    desc: "读取步骤观察，产出最终回复",
  },
  condition: {
    name: "条件分支",
    type: "condition",
    desc: "按变量判定选择一条出边",
  },
  join: {
    name: "汇聚分支",
    type: "join",
    desc: "等待并行分支后继续；all 等全部，any 等任一",
  },
};

/**
 * 读取节点类型的中文展示元数据
 * @param type 节点类型
 * @returns 返回展示名、英文类型名与说明
 * @description 未登记的类型回退原始串，不映射到某个已知类型——那会把陌生节点显示成别的东西。
 */
export function nodeTypeMeta(type: string): NodeTypeMeta {
  return (
    NODE_TYPE_META[type as FlowNodeType] ?? {
      name: type,
      type,
      desc: "未知节点类型，后台可能落后于后端契约",
    }
  );
}

/**
 * 读取分支键的中文展示名
 * @param branch 分支键
 * @returns 返回可直接画在边上的短标签
 * @description `default` 边不加标签（画上去只是噪音）；`case_*` 保留原键，因为它是用户在
 * condition 里自己命名的分支，替换成序号会让画布和 JSON 对不上。
 */
export function branchLabel(branch: string): string {
  if (branch === FLOW_DEFAULT_BRANCH) {
    return "";
  }
  if (branch === FLOW_CONDITION_ELSE_BRANCH) {
    return "否则";
  }
  if (branch === "approved") {
    return "已确认";
  }
  return branch;
}

/** 画布节点的默认横纵间距，仅在 Definition 没有 layout 时使用。 */
const AUTO_LAYOUT_GAP = { x: 280, y: 140 } as const;

/**
 * 把 FlowDefinition 投影为画布视图
 * @param definition 已由服务端校验过的 Definition
 * @returns 返回节点与边的视图数组
 * @description 只做投影，不做结构校验：合法性由服务端校验器唯一裁定，前端再抄一份规则必然漂移。
 * 但节点类型、分支键这些**闭集**从共享契约读（`flowNodeBranchKeys` 等），不在这里重写一份。
 * layout 缺失时按拓扑层次自动排布，保证老工件和刚导入的 JSON 也能看。
 */
export function toFlowGraph(definition: CanvasDefinition): FlowGraph {
  const layout = definition.layout?.nodes ?? {};
  const depths = computeDepths(definition);
  const rowCursor = new Map<number, number>();

  const nodes = definition.nodes.map((node) => {
    const saved = layout[node.id];
    if (saved) {
      return {
        id: node.id,
        ...(node.name ? { name: node.name } : {}),
        type: node.type,
        position: saved,
        config: node.config,
      };
    }
    const depth = depths.get(node.id) ?? 0;
    const row = rowCursor.get(depth) ?? 0;
    rowCursor.set(depth, row + 1);
    return {
      id: node.id,
      ...(node.name ? { name: node.name } : {}),
      type: node.type,
      position: { x: depth * AUTO_LAYOUT_GAP.x, y: row * AUTO_LAYOUT_GAP.y },
      config: node.config,
    };
  });

  // join 的入边额外标出「等 / 不等」：连进来但没被 waitFor 选中的分支照常执行，却不会被
  // 等待——这个差别在画布上原本完全看不见，是会静默配错的地方。
  const joinWaitFor = new Map<string, ReadonlySet<string>>();
  for (const node of definition.nodes) {
    if (node.type !== "join") {
      continue;
    }
    const raw = (node.config as { waitFor?: unknown } | undefined)?.waitFor;
    joinWaitFor.set(
      node.id,
      new Set(
        Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [],
      ),
    );
  }

  const edges = definition.edges.map((edge) => {
    const branch = edge.when ?? FLOW_DEFAULT_BRANCH;
    const waited = joinWaitFor.get(edge.to);
    return {
      id: edgeId(edge),
      source: edge.from,
      target: edge.to,
      branch,
      label: waited
        ? waited.has(edge.from)
          ? "等待"
          : "不等待"
        : branchLabel(branch),
    };
  });

  return { nodes, edges };
}

/**
 * 取出每个节点当前**实际渲染**的坐标
 * @param definition 当前画布定义
 * @returns 返回节点标识到坐标的完整映射
 * @description 与 toFlowGraph 用同一套规则：有存下来的坐标就用它，没有就用自动排布的结果。
 * 编辑器必须基于这个而不是 `layout.nodes` 来算新节点落点——模板不带 layout，直接读那个
 * 稀疏映射会算出 maxX=0，新节点正好压在第二列的节点上。
 */
export function layoutPositions(
  definition: CanvasDefinition,
): Record<string, FlowNodePosition> {
  const positions: Record<string, FlowNodePosition> = {};
  for (const node of toFlowGraph(definition).nodes) {
    positions[node.id] = node.position;
  }
  return positions;
}

/**
 * 生成一条边的稳定标识
 * @param edge Definition 里的边
 * @returns 返回 `from:branch:to` 形式的标识
 * @description 用分支键而不是数组下标：下标会在增删边后整体位移，让画布错认成"所有边都变了"。
 */
export function edgeId(edge: {
  from: string;
  to: string;
  when?: string;
}): string {
  return `${edge.from}:${edge.when ?? FLOW_DEFAULT_BRANCH}:${edge.to}`;
}

/**
 * 计算每个节点距入口的层数
 * @param definition 目标 Definition
 * @returns 返回节点标识到层数的映射
 * @description 只用于没有 layout 时的默认排布。走最长路径而不是最短：菱形结构下用最短路
 * 会把汇聚节点画到和它的一个上游同列，边变成往回走的短线，看着像环。
 * 图可能不合法（用户正在编辑一个还没通过校验的草稿），因此带访问集合防环。
 */
function computeDepths(definition: CanvasDefinition): Map<string, number> {
  const successors = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const edge of definition.edges) {
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
    hasIncoming.add(edge.to);
  }

  const depths = new Map<string, number>();
  const walk = (nodeId: string, depth: number, path: Set<string>): void => {
    if (path.has(nodeId)) {
      return;
    }
    if ((depths.get(nodeId) ?? -1) >= depth) {
      return;
    }
    depths.set(nodeId, depth);
    const nextPath = new Set(path).add(nodeId);
    for (const target of successors.get(nodeId) ?? []) {
      walk(target, depth + 1, nextPath);
    }
  };

  for (const node of definition.nodes) {
    if (!hasIncoming.has(node.id)) {
      walk(node.id, 0, new Set());
    }
  }
  // 入口缺失或全是环时上面一个都走不到，兜底给 0，让画布至少能把节点摆出来
  for (const node of definition.nodes) {
    if (!depths.has(node.id)) {
      depths.set(node.id, 0);
    }
  }
  return depths;
}

/**
 * 列出一个节点尚未连出的分支键
 * @param node 目标节点
 * @param edges 当前全部边
 * @returns 返回缺少出边的分支键
 * @description 服务端的 `branch-coverage` 规则要求「声明分支全连或全不连」。画布用它在保存前
 * 就把缺口标出来，而不是让用户点了保存才收到一个指向节点的错误。
 */
export function missingBranches(
  node: FlowNode,
  edges: readonly FlowEdge[],
): string[] {
  const declared = flowNodeBranchKeys(node);
  const covered = new Set(
    edges
      .filter((edge) => edge.from === node.id)
      .map((edge) => edge.when ?? FLOW_DEFAULT_BRANCH),
  );
  if (covered.size === 0) {
    return [];
  }
  return declared.filter((branch) => !covered.has(branch));
}

/**
 * 列出一个节点声明的输出字段
 * @param type 节点类型
 * @returns 返回字段名到值类型的条目
 * @description 直接读共享契约的 FLOW_NODE_OUTPUTS，变量选择器和后端类型检查因此用同一份事实。
 */
export function nodeOutputEntries(
  type: FlowNodeType,
): Array<{ field: string; valueType: string }> {
  return Object.entries(FLOW_NODE_OUTPUTS[type] ?? {}).map(
    ([field, valueType]) => ({ field, valueType }),
  );
}

/** 变量选择器的一个可选项。 */
export interface FlowVariableOption {
  /** 落库时写进 $ref 的元组 */
  ref: readonly [string, string];
  /** 来源节点标识 */
  sourceId: string;
  /** 输出字段名 */
  field: string;
  /** 该输出的值类型，用于过滤算子 */
  valueType: string;
  /** 展示用标签，例如「start.text（string）」 */
  label: string;
}

/**
 * 列出一个节点可以合法引用的全部变量
 * @param nodeId 目标节点标识
 * @param definition 当前画布定义
 * @returns 返回按来源节点顺序排列的可选项
 * @description 只列**支配**目标节点的来源，与服务端 `ref-dominates` 用的是共享契约里同一个
 * `flowDominators`：让选择器里出现一个后端注定拒绝的选项，等于把用户往错误里推。
 */
export function variableOptions(
  nodeId: string,
  definition: CanvasDefinition,
  /** 只保留该字段名的输出；用于 planRef 这类固定字段的引用 */
  onlyField?: string,
): FlowVariableOption[] {
  const dominators = flowMustCompleteBefore(definition.nodes, definition.edges);
  const dominating = dominators.get(nodeId);
  if (!dominating) {
    return [];
  }
  const options: FlowVariableOption[] = [];
  for (const node of definition.nodes) {
    if (node.id === nodeId || !dominating.has(node.id)) {
      continue;
    }
    for (const { field, valueType } of nodeOutputEntries(node.type)) {
      if (onlyField && field !== onlyField) {
        continue;
      }
      options.push({
        ref: [node.id, field],
        sourceId: node.id,
        field,
        valueType,
        label: `${node.id}.${field}（${valueType}）`,
      });
    }
  }
  return options;
}
