import type {
  FlowDefinition,
  FlowEdgeWhen,
  FlowNode,
} from '@litter-bear/types/agent-flow';
import { FlowDefinitionSchema } from './flow-definition.schema';

export { calculateFlowDefinitionDigest } from './flow-definition.digest';
export { createFlowDefinitionPreset } from './flow-definition.templates';

/** 单个 FlowDefinition 校验错误。 */
export interface FlowDefinitionValidationError {
  path: string;
  rule: string;
  message: string;
}

/** FlowDefinition 解析和结构校验结果。 */
export type FlowDefinitionValidationResult =
  | { success: true; definition: FlowDefinition }
  | { success: false; errors: FlowDefinitionValidationError[] };

/**
 * 解析并校验外部输入的 FlowDefinition JSON
 * @param input 管理端导入或草稿编辑提交的未知 JSON
 * @returns 返回不可变的有效 Definition，或包含字段路径和中文说明的错误集合
 * @description 先用 Zod 拒绝未知字段、错误类型和超限数据，再验证图的入口、边、可达终点与环约束；不访问数据库或能力注册表。
 */
export function validateFlowDefinition(
  input: unknown,
): FlowDefinitionValidationResult {
  const parsed = FlowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '$',
        rule: 'schema',
        message: `字段格式不合法：${issue.message}`,
      })),
    };
  }

  const definition = parsed.data as FlowDefinition;
  const errors = validateGraphStructure(definition);
  return errors.length === 0
    ? { success: true, definition }
    : { success: false, errors };
}

/**
 * 校验 FlowDefinition 的图结构约束
 * @param definition 已通过 Zod 字段和范围解析的 Definition
 * @returns 返回全部发现的图结构错误
 * @description 结构检查独立于 JSON schema，保证导入者能一次看到重复节点、非法边、入口、终点与环等全部问题。
 */
function validateGraphStructure(
  definition: FlowDefinition,
): FlowDefinitionValidationError[] {
  const errors: FlowDefinitionValidationError[] = [];
  const nodesById = new Map<string, FlowNode>();

  definition.nodes.forEach((node, index) => {
    if (nodesById.has(node.id)) {
      errors.push({
        path: `nodes.${index}.id`,
        rule: 'unique-node-id',
        message: `节点标识「${node.id}」重复`,
      });
      return;
    }
    nodesById.set(node.id, node);
  });

  const validEdges = definition.edges.filter((edge, index) => {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    let valid = true;

    if (!from) {
      valid = false;
      errors.push({
        path: `edges.${index}.from`,
        rule: 'edge-node-exists',
        message: `起点节点「${edge.from}」不存在`,
      });
    }
    if (!to) {
      valid = false;
      errors.push({
        path: `edges.${index}.to`,
        rule: 'edge-node-exists',
        message: `终点节点「${edge.to}」不存在`,
      });
    }
    if (from && !isValidEdgeWhen(from, edge.when)) {
      valid = false;
      errors.push({
        path: `edges.${index}.when`,
        rule: 'edge-when',
        message: `节点「${from.id}」不支持分支「${edge.when ?? 'default'}」`,
      });
    }
    return valid;
  });

  validateDuplicateBranches(validEdges, errors);
  validateEntryAndTerminalNodes(definition.nodes, validEdges, errors);
  if (hasCycle(definition.nodes, validEdges)) {
    errors.push({
      path: 'edges',
      rule: 'cycle',
      message:
        'V1 Flow 不允许节点之间形成环；PlanLoop 的循环必须保留在节点内部',
    });
  } else {
    validatePlanPrerequisite(definition.nodes, validEdges, errors);
  }
  return errors;
}

/**
 * 检查依赖计划的节点前面是否必定存在 plan 节点
 * @param nodes 全部节点
 * @param edges 端点和分支均有效的边集合
 * @param errors 用于累积校验错误的数组
 * @returns 无返回值
 * @description plan-loop 与 approval 在运行时都要读取 plan 节点写入的计划；缺少前置 plan 时
 * Activity 会抛 AGENT_FLOW_PLAN_STATE_MISSING 直接终止任务。这个错误必须在发布期就拦住，
 * 否则一个能通过发布校验的 Flow 会在每个终端用户身上炸。要求「每条路径上都有」而不是
 * 「存在一条路径有」：只要有一条绕开 plan 的分支，那条分支上的运行就会失败。
 */
function validatePlanPrerequisite(
  nodes: readonly FlowNode[],
  edges: readonly FlowDefinition['edges'][number][],
  errors: FlowDefinitionValidationError[],
): void {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const predecessors = new Map<string, string[]>();
  const outdegreeTargets = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
  }
  for (const edge of edges) {
    predecessors.set(edge.to, [
      ...(predecessors.get(edge.to) ?? []),
      edge.from,
    ]);
    outdegreeTargets.set(edge.from, [
      ...(outdegreeTargets.get(edge.from) ?? []),
      edge.to,
    ]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  // 拓扑序上做一次前向数据流：planGuaranteed 表示「到达该节点前必定已执行过 plan」
  const planGuaranteed = new Map<string, boolean>();
  const ready = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  while (ready.length > 0) {
    const nodeId = ready.shift();
    if (!nodeId) {
      continue;
    }
    const incoming = predecessors.get(nodeId) ?? [];
    planGuaranteed.set(
      nodeId,
      incoming.length > 0 &&
        incoming.every(
          (from) =>
            planGuaranteed.get(from) === true ||
            nodesById.get(from)?.type === 'plan',
        ),
    );
    for (const target of outdegreeTargets.get(nodeId) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
      }
    }
  }

  nodes.forEach((node, index) => {
    if (node.type !== 'plan-loop' && node.type !== 'approval') {
      return;
    }
    if (planGuaranteed.get(node.id) === true) {
      return;
    }
    errors.push({
      path: `nodes.${index}.id`,
      rule: 'plan-prerequisite',
      message: `节点「${node.id}」依赖计划，其之前的每条路径上都必须存在 plan 节点`,
    });
  });
}

/**
 * 判断边的分支标识是否与源节点类型匹配
 * @param node 边的源节点
 * @param when 用户声明的可选分支标识
 * @returns 当节点允许该分支时返回 true
 * @description 非分支节点只能使用无 when 的默认边，审批节点只能使用 approved 分支。
 */
function isValidEdgeWhen(node: FlowNode, when: FlowEdgeWhen | undefined) {
  if (node.type === 'approval') {
    return when === 'approved';
  }
  return when === undefined;
}

/**
 * 检查一个源节点是否重复声明相同分支
 * @param edges 端点和分支均有效的边集合
 * @param errors 用于累积校验错误的数组
 * @returns 无返回值
 * @description 同一默认边或同一 approval 分支只能出现一次，防止运行时无法确定下一跳。
 */
function validateDuplicateBranches(
  edges: readonly FlowDefinition['edges'][number][],
  errors: FlowDefinitionValidationError[],
): void {
  const seen = new Set<string>();
  edges.forEach((edge, index) => {
    const branchKey = `${edge.from}:${edge.when ?? 'default'}`;
    if (seen.has(branchKey)) {
      errors.push({
        path: `edges.${index}`,
        rule: 'unique-edge-branch',
        message: `节点「${edge.from}」的分支「${edge.when ?? 'default'}」重复`,
      });
      return;
    }
    seen.add(branchKey);
  });
}

/**
 * 检查唯一入口、可达终点和孤立节点
 * @param nodes Definition 内的全部节点
 * @param edges 已验证端点的边集合
 * @param errors 用于累积校验错误的数组
 * @returns 无返回值
 * @description 运行时从唯一入口开始推进；所有节点必须可达，且至少存在一个从入口可达的终点。
 */
function validateEntryAndTerminalNodes(
  nodes: readonly FlowNode[],
  edges: readonly FlowDefinition['edges'][number][],
  errors: FlowDefinitionValidationError[],
): void {
  const incoming = new Set(edges.map((edge) => edge.to));
  const entryNodes = nodes.filter((node) => !incoming.has(node.id));
  if (entryNodes.length !== 1) {
    errors.push({
      path: 'nodes',
      rule: 'unique-entry',
      message: `Flow 必须有且仅有一个入口节点，当前为 ${entryNodes.length} 个`,
    });
    return;
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }

  const reachable = new Set<string>();
  const pending = [entryNodes[0].id];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || reachable.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    pending.push(...(outgoing.get(nodeId) ?? []));
  }

  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      errors.push({
        path: 'nodes',
        rule: 'reachable-node',
        message: `节点「${node.id}」无法从入口到达`,
      });
    }
  }

  const hasReachableTerminal = nodes.some(
    (node) => reachable.has(node.id) && !(outgoing.get(node.id)?.length ?? 0),
  );
  if (!hasReachableTerminal) {
    errors.push({
      path: 'nodes',
      rule: 'reachable-terminal',
      message: 'Flow 必须至少有一个从入口可达的终点节点',
    });
  }
}

/**
 * 检查节点图是否存在有向环
 * @param nodes Definition 内的全部节点
 * @param edges 已验证端点的边集合
 * @returns 存在环时返回 true
 * @description 使用深度优先遍历的 visiting 状态检测回边；PlanLoop 不通过图边表达循环，故和其他节点一样参与检查。
 */
function hasCycle(
  nodes: readonly FlowNode[],
  edges: readonly FlowDefinition['edges'][number][],
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) {
      return true;
    }
    if (visited.has(nodeId)) {
      return false;
    }
    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      if (visit(target)) {
        return true;
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return nodes.some((node) => visit(node.id));
}
