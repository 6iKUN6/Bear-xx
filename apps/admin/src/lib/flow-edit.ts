import {
  FLOW_CONDITION_ELSE_BRANCH,
  FLOW_DEFAULT_BRANCH,
  flowNodeBranchKeys,
  type FlowNode,
  type FlowNodeType,
} from "@litter-bear/types/agent-flow";
import type { FlowNodePosition } from "@/lib/flow-graph";

/**
 * 可编辑的 Definition 草稿
 * @description 保留服务端返回的全部顶层字段（policy、name、schemaVersion 等）原样不动，
 * 编辑器只改 nodes / edges / layout。这样不认识的字段不会在一次保存里被抹掉。
 */
export interface EditableDefinition {
  [key: string]: unknown;
  nodes: EditableNode[];
  edges: EditableEdge[];
  layout?: { nodes: Record<string, FlowNodePosition> };
}

export interface EditableNode {
  id: string;
  /** 面向人的显示名；缺省时界面回退显示 id */
  name?: string;
  type: FlowNodeType;
  config: Record<string, unknown>;
}

export interface EditableEdge {
  from: string;
  to: string;
  when?: string;
}

/** 一次编辑操作的结果；被护栏挡住时给出可直接展示的原因。 */
export type EditResult =
  { ok: true; definition: EditableDefinition } | { ok: false; reason: string };

/**
 * 把服务端 Definition 读成可编辑草稿
 * @param definition 服务端返回的 Definition 原文
 * @returns 可编辑时返回草稿，否则返回原因
 * @description 与画布投影一样只检查**能不能编辑**，不判断结构是否合法——合法性由服务端裁定。
 * 顶层其他字段整体保留。
 */
export function toEditableDefinition(definition: object): EditResult {
  const source = definition as Record<string, unknown>;
  if (!Array.isArray(source.nodes) || !Array.isArray(source.edges)) {
    return { ok: false, reason: "Definition 缺少 nodes 或 edges 数组" };
  }
  const nodes: EditableNode[] = [];
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
    nodes.push({
      id: candidate.id,
      ...(typeof candidate.name === "string" && candidate.name
        ? { name: candidate.name }
        : {}),
      type: candidate.type as FlowNodeType,
      config: isRecord(candidate.config) ? { ...candidate.config } : {},
    });
  }
  const edges: EditableEdge[] = [];
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
  return { ok: true, definition: { ...source, nodes, edges } };
}

/** 每种节点类型新建时的默认 config；与后端 Zod schema 的必填项对齐。 */
const DEFAULT_CONFIG: Record<FlowNodeType, () => Record<string, unknown>> = {
  start: () => ({}),
  agent: () => ({
    modelPreset: "agent-default",
    toolGroups: [],
    skills: [],
    maxToolIterations: 4,
  }),
  plan: () => ({ maxSteps: 6 }),
  "plan-loop": () => ({
    executor: {
      type: "agent",
      modelPreset: "agent-default",
      toolGroups: [],
      skills: [],
      maxToolIterations: 4,
    },
    stopPolicy: "all-steps",
  }),
  approval: () => ({ kind: "plan-review" }),
  synthesize: () => ({}),
  condition: () => ({
    cases: [
      {
        key: "case_1",
        logic: "and",
        conditions: [],
      },
    ],
  }),
};

/**
 * 新增一个节点
 * @param definition 当前草稿
 * @param type 节点类型
 * @param position 新节点的画布落点
 * @param currentPositions 现有节点当前实际渲染的坐标（来自 layoutPositions）
 * @returns 返回新草稿；start 已存在时拒绝
 * @description 默认 config 与后端 Zod 的必填项对齐，否则新建的节点一定校验不过，用户得先去
 * JSON 编辑器补字段才能保存。start 有且仅有一个，直接在这里挡住。
 *
 * 会把现有节点的坐标一并写实：模板通常不带 layout，此前只写新节点的坐标会造成
 * 「一部分节点用存下来的坐标、一部分走自动排布」，两套坐标系混用必然重叠——
 * 实测新节点正好压在第二列节点上。加节点后本来就已经是脏状态，写实 layout 不额外造成困扰。
 */
export function addNode(
  definition: EditableDefinition,
  type: FlowNodeType,
  position: FlowNodePosition,
  currentPositions: Record<string, FlowNodePosition>,
): EditResult {
  if (type === "start" && definition.nodes.some((n) => n.type === "start")) {
    return { ok: false, reason: "start 节点有且仅有一个" };
  }
  const id = nextNodeId(definition, type);
  return {
    ok: true,
    definition: {
      ...definition,
      nodes: [
        ...definition.nodes,
        { id, type, config: DEFAULT_CONFIG[type]() },
      ],
      layout: { nodes: { ...currentPositions, [id]: position } },
    },
  };
}

/**
 * 删除一个节点及其所有连边
 * @param definition 当前草稿
 * @param nodeId 目标节点
 * @returns 返回新草稿；start 节点拒绝删除
 * @description 连带删掉相关边，避免留下端点不存在的悬空边——那会让服务端报一堆
 * edge-node-exists，掩盖用户真正关心的问题。
 */
export function removeNode(
  definition: EditableDefinition,
  nodeId: string,
): EditResult {
  const node = definition.nodes.find((item) => item.id === nodeId);
  if (!node) {
    return { ok: false, reason: "节点不存在" };
  }
  if (node.type === "start") {
    return { ok: false, reason: "start 是流程入口，不能删除" };
  }
  const layout = { ...(definition.layout?.nodes ?? {}) };
  delete layout[nodeId];
  return {
    ok: true,
    definition: {
      ...definition,
      nodes: definition.nodes.filter((item) => item.id !== nodeId),
      edges: definition.edges.filter(
        (edge) => edge.from !== nodeId && edge.to !== nodeId,
      ),
      layout: { nodes: layout },
    },
  };
}

/**
 * 连一条边
 * @param definition 当前草稿
 * @param from 起点节点
 * @param to 终点节点
 * @param branch 分支键
 * @returns 返回新草稿，或被护栏挡住的原因
 * @description 三条护栏，都对应服务端一定会拒绝的图，先在这里挡住比让用户点保存再收 400 好：
 * 1. 分支键必须是源节点声明过的（`edge-when`）
 * 2. 同一分支只能连一条出边——**这同时意味着画布画不出 fan-out**，因为普通节点只有 default
 *    一个分支键。并行尚未落地，能画出来就是给一个后端 100% 拒绝的按钮
 * 3. 自环直接拒（`cycle` 的最简情形，在这里给的原因比图级报错精确）
 * 更复杂的环、可达性、ref-dominates 仍由服务端裁定，前端不重写那些规则。
 */
export function connect(
  definition: EditableDefinition,
  from: string,
  to: string,
  branch: string,
): EditResult {
  if (from === to) {
    return { ok: false, reason: "不能连到自己：Flow 不允许图上的环" };
  }
  const source = definition.nodes.find((node) => node.id === from);
  if (!source || !definition.nodes.some((node) => node.id === to)) {
    return { ok: false, reason: "端点节点不存在" };
  }
  const declared = branchKeysOf(source);
  if (!declared.includes(branch)) {
    return {
      ok: false,
      reason: `节点「${from}」没有声明分支「${branch}」`,
    };
  }
  const occupied = definition.edges.some(
    (edge) =>
      edge.from === from && (edge.when ?? FLOW_DEFAULT_BRANCH) === branch,
  );
  if (occupied) {
    return {
      ok: false,
      reason:
        branch === FLOW_DEFAULT_BRANCH
          ? `节点「${from}」已有一条出边；并行扇出尚未支持`
          : `节点「${from}」的分支「${branch}」已有出边`,
    };
  }
  return {
    ok: true,
    definition: {
      ...definition,
      edges: [
        ...definition.edges,
        {
          from,
          to,
          ...(branch === FLOW_DEFAULT_BRANCH ? {} : { when: branch }),
        },
      ],
    },
  };
}

/**
 * 删除一条边
 * @param definition 当前草稿
 * @param from 起点
 * @param to 终点
 * @param branch 分支键
 * @returns 返回新草稿
 */
export function disconnect(
  definition: EditableDefinition,
  from: string,
  to: string,
  branch: string,
): EditResult {
  return {
    ok: true,
    definition: {
      ...definition,
      edges: definition.edges.filter(
        (edge) =>
          !(
            edge.from === from &&
            edge.to === to &&
            (edge.when ?? FLOW_DEFAULT_BRANCH) === branch
          ),
      ),
    },
  };
}

/**
 * 记录节点被拖动后的坐标
 * @param definition 当前草稿
 * @param nodeId 节点标识
 * @param position 新坐标
 * @returns 返回新草稿
 * @description layout 已被排除在 digest 之外，因此挪位置不会改变工件语义，但仍算改动、需要保存。
 */
export function moveNode(
  definition: EditableDefinition,
  nodeId: string,
  position: FlowNodePosition,
): EditableDefinition {
  return {
    ...definition,
    layout: {
      nodes: { ...(definition.layout?.nodes ?? {}), [nodeId]: position },
    },
  };
}

/**
 * 覆盖一个节点的 config
 * @param definition 当前草稿
 * @param nodeId 节点标识
 * @param config 新的完整 config
 * @returns 返回新草稿
 */
export function updateNodeConfig(
  definition: EditableDefinition,
  nodeId: string,
  config: Record<string, unknown>,
): EditableDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.id === nodeId ? { ...node, config } : node,
    ),
  };
}

/**
 * 设置一个节点的显示名
 * @param definition 当前草稿
 * @param nodeId 节点标识
 * @param name 新显示名；传空串即清除，界面回退显示 id
 * @returns 返回新草稿
 * @description 只动 `name`，不碰 `id`。这正是加这个字段的理由：`id` 被 edges 的 from/to、
 * `$ref` 的第一个元素和 layout 的键引用，改它要同步改三处，漏一处就断链；改显示名不会
 * 影响任何引用。空白名会被服务端拒绝（和「没起名」在界面上无法区分，却会让 digest 变化），
 * 因此这里把只含空格的输入当作清除。
 */
export function setNodeName(
  definition: EditableDefinition,
  nodeId: string,
  name: string,
): EditableDefinition {
  const trimmed = name.trim();
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.id !== nodeId) {
        return node;
      }
      if (trimmed) {
        return { ...node, name: trimmed };
      }
      // 清除时删掉整个键而不是留空串：空串会进 digest，让「没起名」和「起了空名」
      // 变成两份不同的工件，而界面上完全一样
      const cleared = { ...node };
      delete cleared.name;
      return cleared;
    }),
  };
}

/**
 * 改一个 condition case 的键，并同步改掉引用它的边
 * @param definition 当前草稿
 * @param nodeId condition 节点
 * @param oldKey 原分支键
 * @param newKey 新分支键
 * @returns 返回新草稿，或被拒原因
 * @description 只改 config 不改边，会让那条边的 `when` 指向一个不存在的分支，服务端报
 * edge-when——用户看到的是"边错了"，而他明明改的是 case 名。两者必须一起改。
 */
export function renameConditionCase(
  definition: EditableDefinition,
  nodeId: string,
  oldKey: string,
  newKey: string,
): EditResult {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(newKey)) {
    return { ok: false, reason: "分支键只能是小写字母开头的字母数字下划线" };
  }
  if (newKey === FLOW_CONDITION_ELSE_BRANCH) {
    return { ok: false, reason: "else 是隐含分支，不能作为 case 名" };
  }
  const node = definition.nodes.find((item) => item.id === nodeId);
  if (!node) {
    return { ok: false, reason: "节点不存在" };
  }
  const cases = Array.isArray(node.config.cases) ? node.config.cases : [];
  if (
    cases.some(
      (item) => isRecord(item) && item.key !== oldKey && item.key === newKey,
    )
  ) {
    return { ok: false, reason: `分支「${newKey}」已存在` };
  }
  return {
    ok: true,
    definition: {
      ...definition,
      nodes: definition.nodes.map((item) =>
        item.id === nodeId
          ? {
              ...item,
              config: {
                ...item.config,
                cases: cases.map((entry) =>
                  isRecord(entry) && entry.key === oldKey
                    ? { ...entry, key: newKey }
                    : entry,
                ),
              },
            }
          : item,
      ),
      edges: definition.edges.map((edge) =>
        edge.from === nodeId && edge.when === oldKey
          ? { ...edge, when: newKey }
          : edge,
      ),
    },
  };
}

/**
 * 列出一个节点声明的分支键
 * @param node 草稿里的节点
 * @returns 分支键数组
 * @description config 可能还不合法，因此 condition 走本地读取，其余交给共享
 * flowNodeBranchKeys——分支规则的事实源仍只有一份。
 */
export function branchKeysOf(node: EditableNode): string[] {
  if (node.type !== "condition") {
    return [...flowNodeBranchKeys({ ...node, config: {} } as FlowNode)];
  }
  const cases = Array.isArray(node.config.cases) ? node.config.cases : [];
  const keys = cases
    .map((item) => (isRecord(item) ? item.key : undefined))
    .filter((key): key is string => typeof key === "string");
  return [...keys, FLOW_CONDITION_ELSE_BRANCH];
}

/**
 * 为新节点生成不冲突的标识
 * @param definition 当前草稿
 * @param type 节点类型
 * @returns 返回形如 `agent_2` 的标识
 * @description 标识要满足后端的 `^[a-z][a-z0-9_-]{0,63}$`，因此 plan-loop 的短横线要换成下划线。
 */
function nextNodeId(
  definition: EditableDefinition,
  type: FlowNodeType,
): string {
  const base = type.replace(/-/g, "_");
  const used = new Set(definition.nodes.map((node) => node.id));
  if (!used.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
