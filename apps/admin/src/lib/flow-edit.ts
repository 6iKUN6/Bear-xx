import {
  FLOW_CONDITION_ELSE_BRANCH,
  FLOW_DEFAULT_BRANCH,
  flowNodeBranchKeys,
  type FlowNode,
  type FlowNodeType,
} from "@litter-bear/types/agent-flow";
import {
  LOOP_CONTAINER_LAYOUT,
  isLoopTechnicalEdge,
  type FlowNodeLayout,
  type FlowNodePosition,
} from "./flow-graph.ts";

/**
 * 可编辑的 Definition 草稿
 * @description 保留服务端返回的全部顶层字段（policy、name、schemaVersion 等）原样不动，
 * 编辑器只改 nodes / edges / layout。这样不认识的字段不会在一次保存里被抹掉。
 */
export interface EditableDefinition {
  [key: string]: unknown;
  nodes: EditableNode[];
  edges: EditableEdge[];
  layout?: { nodes: Record<string, FlowNodeLayout> };
}

export interface EditableNode {
  id: string;
  /** 面向人的显示名；缺省时界面回退显示 id */
  name?: string;
  /** 面向编辑者的简短说明；缺省时不显示。 */
  description?: string;
  /** 所属 Loop 容器；存在时 layout 坐 持有相对容器坐标。 */
  loopId?: string;
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
      description?: unknown;
      loopId?: unknown;
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
      ...(typeof candidate.description === "string" && candidate.description
        ? { description: candidate.description }
        : {}),
      ...(typeof candidate.loopId === "string"
        ? { loopId: candidate.loopId }
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
  end: () => ({}),
  agent: () => ({
    toolGroups: [],
    skills: [],
    maxToolIterations: 4,
  }),
  plan: () => ({ maxSteps: 6 }),
  // planRef 留空对象：它是必填的引用，但新节点还没连线、没有可引用的上游，
  // 只能由用户在 inspector 里选。保存时服务端会以 schema 错误拒绝，inspector 已就地提示。
  "plan-loop": () => ({
    executor: {
      type: "agent",
      toolGroups: [],
      skills: [],
      maxToolIterations: 4,
    },
    stopPolicy: "all-steps",
  }),
  approval: () => ({ kind: "plan-review", policy: "always" }),
  synthesize: () => ({}),
  // waitFor 留空：新节点还没有入边，等谁只能由用户在 inspector 里选
  join: () => ({ waitFor: [], policy: "all" }),
  // continueWhen 留空即「只按 maxIterations 跑满」，是合法配置；要按条件退出再去
  // inspector 里加判定
  loop: () => ({ maxIterations: 3, continueWhen: [] }),
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
 * @returns 返回新草稿；start 或 end 已存在时拒绝
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
  currentPositions: Record<string, FlowNodeLayout>,
): EditResult {
  if (type === "start" && definition.nodes.some((n) => n.type === "start")) {
    return { ok: false, reason: "start 节点有且仅有一个" };
  }
  if (type === "end" && definition.nodes.some((n) => n.type === "end")) {
    return { ok: false, reason: "end 节点有且仅有一个" };
  }
  const id = nextNodeId(definition, type);
  const loopId = canBelongToLoop(type)
    ? findLoopAtPosition(definition, position, currentPositions)
    : undefined;
  const storedPosition = loopId
    ? toRelativePosition(position, currentPositions[loopId])
    : position;
  const layout: FlowNodeLayout =
    type === "loop"
      ? {
          ...position,
          width: LOOP_CONTAINER_LAYOUT.width,
          height: LOOP_CONTAINER_LAYOUT.height,
          collapsed: false,
        }
      : storedPosition;
  return {
    ok: true,
    definition: rebuildLoopTechnicalEdges({
      ...definition,
      nodes: [
        ...definition.nodes,
        {
          id,
          type,
          ...(loopId ? { loopId } : {}),
          config: DEFAULT_CONFIG[type](),
        },
      ],
      layout: { nodes: { ...currentPositions, [id]: layout } },
    }),
  };
}

/**
 * 删除一个节点及其所有连边
 * @param definition 当前草稿
 * @param nodeId 目标节点
 * @returns 返回新草稿；start 与 end 节点拒绝删除
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
  if (node.type === "end") {
    return { ok: false, reason: "end 是流程唯一出口，不能删除" };
  }
  if (
    node.type === "loop" &&
    definition.nodes.some((item) => item.loopId === nodeId)
  ) {
    return { ok: false, reason: "Loop 内仍有节点，请先将它们移出容器" };
  }
  const layout = { ...(definition.layout?.nodes ?? {}) };
  delete layout[nodeId];
  const edges = definition.edges.filter(
    (edge) => edge.from !== nodeId && edge.to !== nodeId,
  );
  return {
    ok: true,
    definition: rebuildLoopTechnicalEdges({
      ...definition,
      nodes: pruneJoinWaitFor(
        definition.nodes.filter((item) => item.id !== nodeId),
        edges,
      ),
      edges,
      layout: { nodes: layout },
    }),
  };
}

/**
 * 复制一个节点
 * @param definition 当前草稿
 * @param nodeId 被复制的节点
 * @param currentPositions 现有节点当前实际渲染的坐标（来自 layoutPositions）
 * @returns 返回新草稿；start/end 或节点不存在时拒绝
 * @description config 深拷贝（structuredClone）：agent 的 toolGroups、condition 的 cases 等
 * 嵌套结构若共享引用，改副本会联动原节点。**不复制边**——复制会撞 unique-edge-branch 护栏，
 * 且副本通常要重新连线；**不复制 name**——两个同名节点在列表里无法区分，回退显示新 id 更清楚。
 */
export function duplicateNode(
  definition: EditableDefinition,
  nodeId: string,
  currentPositions: Record<string, FlowNodeLayout>,
): EditResult {
  const source = definition.nodes.find((item) => item.id === nodeId);
  if (!source) {
    return { ok: false, reason: "节点不存在" };
  }
  if (source.type === "start" || source.type === "end") {
    return { ok: false, reason: "start 与 end 有且仅有一个，不能复制" };
  }
  const id = nextNodeId(definition, source.type);
  const origin = currentPositions[nodeId] ?? { x: 0, y: 0 };
  return {
    ok: true,
    definition: rebuildLoopTechnicalEdges({
      ...definition,
      nodes: [
        ...definition.nodes,
        {
          id,
          type: source.type,
          ...(source.loopId ? { loopId: source.loopId } : {}),
          config: structuredClone(source.config),
        },
      ],
      layout: {
        nodes: {
          ...currentPositions,
          [id]: { x: origin.x + 40, y: origin.y + 40 },
        },
      },
    }),
  };
}

/**
 * 断开一个节点的所有连线
 * @param definition 当前草稿
 * @param nodeId 目标节点
 * @returns 返回新草稿；节点不存在时拒绝
 * @description 节点本身保留；join 的 waitFor 引用随边一并收敛（复用 pruneJoinWaitFor）。
 * start/end 允许断线——唯一性约束针对的是节点本身，不是它的边。
 */
export function disconnectNodeAll(
  definition: EditableDefinition,
  nodeId: string,
): EditResult {
  if (!definition.nodes.some((item) => item.id === nodeId)) {
    return { ok: false, reason: "节点不存在" };
  }
  const edges = definition.edges.filter(
    (edge) => edge.from !== nodeId && edge.to !== nodeId,
  );
  if (edges.length === definition.edges.length) {
    return { ok: false, reason: "该节点没有连线" };
  }
  return {
    ok: true,
    definition: rebuildLoopTechnicalEdges({
      ...definition,
      nodes: pruneJoinWaitFor(definition.nodes, edges),
      edges,
    }),
  };
}

/**
 * 剪掉 join 节点上已经失效的 waitFor 引用
 * @param nodes 当前节点集合
 * @param edges 剪枝后的边集合
 * @returns 返回 waitFor 与入边一致的节点集合
 * @description join 只能等真正连进来的分支（服务端 `join-wait-for`）。删节点或断连线之后
 * waitFor 里会残留悬空 id，保存时才报错，而用户早就忘了刚删的是什么。这里就地收敛。
 *
 * 留空是允许的中间态：新建 join 还没有入边时 waitFor 本来就是空的，inspector 会就地提示。
 */
function pruneJoinWaitFor(
  nodes: EditableNode[],
  edges: EditableEdge[],
): EditableNode[] {
  return nodes.map((node) => {
    if (node.type !== "join" || !Array.isArray(node.config.waitFor)) {
      return node;
    }
    const incoming = new Set(
      edges.filter((edge) => edge.to === node.id).map((edge) => edge.from),
    );
    const waitFor = node.config.waitFor.filter(
      (id): id is string => typeof id === "string" && incoming.has(id),
    );
    if (waitFor.length === node.config.waitFor.length) {
      return node;
    }
    return { ...node, config: { ...node.config, waitFor } };
  });
}

/**
 * 连一条边
 * @param definition 当前草稿
 * @param from 起点节点
 * @param to 终点节点
 * @param branch 分支键
 * @returns 返回新草稿，或被护栏挡住的原因
 * @description 五条护栏，都对应服务端一定会拒绝的图，先在这里挡住比让用户点保存再收 400 好：
 * 1. 分支键必须是源节点声明过的（`edge-when`）
 * 2. **具名分支**只能连一条出边（`unique-edge-branch`）：condition 的一个 case 或 approval 的
 *    一个决定连出两条边时，运行时无法确定走哪条
 * 3. default 分支允许多条出边——那就是并行扇出，全部并发启动
 * 4. 同一对端点之间不能重复连同一条边（`duplicate-edge`）：画两次不是并行，是误操作
 * 5. 自环直接拒：合法循环至少要有一个体内节点，不能把 loop 直接连回自己
 *
 * 刻意不在这里做的：`implicit-convergence`（非 join 节点被多条可能并发的边连入）与
 * `concurrent-answer-nodes`（两个可能并发的回复终节点）。两者都要判定「这两条分支是否互斥」，
 * 而互斥判定依赖服务端 validator 里的 `isMutuallyExclusive`。在前端复刻它就是两份事实源，
 * 且判错会挡掉合法图——condition 各分支汇聚、由 loop 圈定的回边都是允许的。这类图级规则
 * 连同普通环、可达性、ref-dominates 一起由服务端裁定，错误按 path 归组后展示。
 */
export function connect(
  definition: EditableDefinition,
  from: string,
  to: string,
  branch: string,
): EditResult {
  const source = definition.nodes.find((node) => node.id === from);
  if (!source || !definition.nodes.some((node) => node.id === to)) {
    return { ok: false, reason: "端点节点不存在" };
  }
  if (from === to) {
    return {
      ok: false,
      reason:
        source.type === "loop"
          ? "loop 不能直接连回自己：循环体必须至少包含一个节点"
          : "节点不能直接连回自己",
    };
  }
  const target = definition.nodes.find((node) => node.id === to);
  if (!target) return { ok: false, reason: "端点节点不存在" };
  const boundaryError = connectionBoundaryError(source, target, branch);
  if (boundaryError) return { ok: false, reason: boundaryError };
  const declared = branchKeysOf(source);
  if (!declared.includes(branch)) {
    return {
      ok: false,
      reason: `节点「${from}」没有声明分支「${branch}」`,
    };
  }
  const sameBranch = definition.edges.filter(
    (edge) =>
      edge.from === from && (edge.when ?? FLOW_DEFAULT_BRANCH) === branch,
  );
  if (branch !== FLOW_DEFAULT_BRANCH && sameBranch.length > 0) {
    return {
      ok: false,
      reason: `节点「${from}」的分支「${branch}」已有出边`,
    };
  }
  if (sameBranch.some((edge) => edge.to === to)) {
    return {
      ok: false,
      reason: `已经有一条「${from}」到「${to}」的连线`,
    };
  }
  return {
    ok: true,
    definition: rebuildLoopTechnicalEdges({
      ...definition,
      edges: [
        ...definition.edges,
        {
          from,
          to,
          ...(branch === FLOW_DEFAULT_BRANCH ? {} : { when: branch }),
        },
      ],
    }),
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
  const edges = definition.edges.filter(
    (edge) =>
      !(
        edge.from === from &&
        edge.to === to &&
        (edge.when ?? FLOW_DEFAULT_BRANCH) === branch
      ),
  );
  return {
    ok: true,
    definition: rebuildLoopTechnicalEdges({
      ...definition,
      nodes: pruneJoinWaitFor(definition.nodes, edges),
      edges,
    }),
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
  currentPositions: Record<string, FlowNodeLayout> = {
    ...(definition.layout?.nodes ?? {}),
  },
): EditResult {
  const node = definition.nodes.find((item) => item.id === nodeId);
  if (!node) return { ok: false, reason: "节点不存在" };
  const nextLoopId = canBelongToLoop(node.type)
    ? findLoopAtPosition(definition, position, currentPositions, nodeId)
    : undefined;
  if (node.loopId !== nextLoopId) {
    const reason = reassignmentBoundaryError(definition, nodeId, nextLoopId);
    if (reason) return { ok: false, reason };
  }
  const previousWithoutTechnical = removeLoopTechnicalEdges(definition);
  const storedPosition = nextLoopId
    ? toRelativePosition(position, currentPositions[nextLoopId])
    : position;
  const nodes = previousWithoutTechnical.nodes.map((item) => {
    if (item.id !== nodeId) return item;
    const updated = { ...item };
    delete updated.loopId;
    return nextLoopId ? { ...updated, loopId: nextLoopId } : updated;
  });
  return {
    ok: true,
    definition: rebuildLoopTechnicalEdges({
      ...previousWithoutTechnical,
      nodes,
      layout: {
        nodes: {
          ...currentPositions,
          [nodeId]: {
            ...currentPositions[nodeId],
            ...storedPosition,
          },
        },
      },
    }),
  };
}

/**
 * 更新 Loop 容器尺寸
 * @param definition 当前草稿
 * @param loopId Loop 节点标识
 * @param size React Flow 交互产生的宽高
 * @returns 节点存在且为 Loop 时返回新草稿，否则返回原草稿
 */
export function resizeLoop(
  definition: EditableDefinition,
  loopId: string,
  size: { width: number; height: number },
): EditableDefinition {
  const node = definition.nodes.find((item) => item.id === loopId);
  if (node?.type !== "loop") return definition;
  const current = definition.layout?.nodes[loopId] ?? { x: 0, y: 0 };
  return {
    ...definition,
    layout: {
      nodes: {
        ...(definition.layout?.nodes ?? {}),
        [loopId]: {
          ...current,
          width: Math.max(LOOP_CONTAINER_LAYOUT.width, size.width),
          height: Math.max(LOOP_CONTAINER_LAYOUT.height, size.height),
        },
      },
    },
  };
}

/**
 * 切换 Loop 折叠状态
 * @param definition 当前草稿
 * @param loopId Loop 节点标识
 * @returns 返回只修改 layout.collapsed 的新草稿
 */
export function toggleLoopCollapsed(
  definition: EditableDefinition,
  loopId: string,
): EditableDefinition {
  const current = definition.layout?.nodes[loopId] ?? {
    x: 0,
    y: 0,
    width: LOOP_CONTAINER_LAYOUT.width,
    height: LOOP_CONTAINER_LAYOUT.height,
  };
  return {
    ...definition,
    layout: {
      nodes: {
        ...(definition.layout?.nodes ?? {}),
        [loopId]: { ...current, collapsed: !(current.collapsed ?? false) },
      },
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
 * 设置一个节点的简短描述
 * @param definition 当前草稿
 * @param nodeId 节点标识
 * @param description 新描述；传空串即清除
 * @returns 返回更新描述后的新草稿
 * @description 描述只服务于编辑者理解节点，不参与连线或变量引用；空白描述会被规范化为缺省字段。
 */
export function setNodeDescription(
  definition: EditableDefinition,
  nodeId: string,
  description: string,
): EditableDefinition {
  const trimmed = description.trim();
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      if (trimmed) return { ...node, description: trimmed };
      const cleared = { ...node };
      delete cleared.description;
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

/** 判断节点类型是否允许成为 Loop 的直接成员。 */
function canBelongToLoop(type: FlowNodeType): boolean {
  return type !== "start" && type !== "end" && type !== "loop";
}

/** 根据节点中心点查找命中的已展开 Loop 容器。 */
function findLoopAtPosition(
  definition: EditableDefinition,
  position: FlowNodePosition,
  layouts: Record<string, FlowNodeLayout>,
  movingNodeId?: string,
): string | undefined {
  for (const node of definition.nodes) {
    if (node.type !== "loop" || node.id === movingNodeId) continue;
    const layout = layouts[node.id];
    if (!layout || layout.collapsed) continue;
    const width = layout.width ?? LOOP_CONTAINER_LAYOUT.width;
    const height = layout.height ?? LOOP_CONTAINER_LAYOUT.height;
    if (
      position.x >= layout.x &&
      position.x <= layout.x + width &&
      position.y >= layout.y &&
      position.y <= layout.y + height
    ) {
      return node.id;
    }
  }
  return undefined;
}

/** 把画布绝对坐标转换为 Loop 内相对坐标。 */
function toRelativePosition(
  absolute: FlowNodePosition,
  loopLayout: FlowNodeLayout | undefined,
): FlowNodePosition {
  return loopLayout
    ? { x: absolute.x - loopLayout.x, y: absolute.y - loopLayout.y }
    : absolute;
}

/** 返回业务连线是否跨越 Loop 容器边界。 */
function connectionBoundaryError(
  source: EditableNode,
  target: EditableNode,
  branch: string,
): string | null {
  if (source.type === "loop") {
    if (branch !== "done") {
      return "Loop 的循环入口由编辑器维护；业务下游请从 done 出口连接";
    }
    if (target.loopId) return "Loop 的 done 出口只能连接容器外节点";
    return null;
  }
  if (target.type === "loop") {
    if (source.loopId) return "Loop 内节点不能直接连接容器入口";
    return null;
  }
  if (source.loopId !== target.loopId) {
    return source.loopId
      ? `节点「${source.id}」只能连接同一 Loop 内的节点`
      : `容器外节点不能绕过 Loop 入口连接内部节点「${target.id}」`;
  }
  return null;
}

/** 归属改变时，已有业务边必须在新层级仍然合法，否则拒绝操作且不改边。 */
function reassignmentBoundaryError(
  definition: EditableDefinition,
  nodeId: string,
  nextLoopId: string | undefined,
): string | null {
  const reassignedNodes = definition.nodes.map((node) =>
    node.id === nodeId ? { ...node, loopId: nextLoopId } : node,
  );
  const projected: EditableDefinition = { ...definition, nodes: reassignedNodes };
  for (const edge of removeLoopTechnicalEdges(definition).edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    const source = projected.nodes.find((node) => node.id === edge.from);
    const target = projected.nodes.find((node) => node.id === edge.to);
    if (!source || !target) continue;
    const reason = connectionBoundaryError(
      source,
      target,
      edge.when ?? FLOW_DEFAULT_BRANCH,
    );
    if (reason) {
      return `不能改变节点归属：连线「${edge.from} → ${edge.to}」将跨越 Loop 边界`;
    }
  }
  return null;
}

/** 删除所有可以由显式 loopId 与内部业务拓扑重新推导的技术边。 */
function removeLoopTechnicalEdges(
  definition: EditableDefinition,
): EditableDefinition {
  return {
    ...definition,
    edges: definition.edges.filter(
      (edge) => !isLoopTechnicalEdge(definition, edge),
    ),
  };
}

/**
 * 按每个 Loop 的唯一入口与唯一回流节点重建技术边
 * @param definition 编辑后的草稿
 * @returns 唯一可推导时包含 again 和回边；多义时不猜测且移除旧技术边
 */
export function rebuildLoopTechnicalEdges(
  definition: EditableDefinition,
): EditableDefinition {
  const clean = removeLoopTechnicalEdges(definition);
  const technical: EditableEdge[] = [];
  for (const loop of clean.nodes.filter((node) => node.type === "loop")) {
    const members = clean.nodes.filter((node) => node.loopId === loop.id);
    const memberIds = new Set(members.map((node) => node.id));
    const internal = clean.edges.filter(
      (edge) => memberIds.has(edge.from) && memberIds.has(edge.to),
    );
    const entries = members.filter(
      (node) => !internal.some((edge) => edge.to === node.id),
    );
    const exits = members.filter(
      (node) => !internal.some((edge) => edge.from === node.id),
    );
    if (entries.length === 1 && exits.length === 1) {
      technical.push(
        { from: loop.id, to: entries[0]!.id, when: "again" },
        { from: exits[0]!.id, to: loop.id },
      );
    }
  }
  return { ...clean, edges: [...clean.edges, ...technical] };
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
