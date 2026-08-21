import {
  FLOW_CONDITION_OPERATORS,
  FLOW_DEFAULT_BRANCH,
  FLOW_INPUT_OUTPUTS,
  FLOW_INPUT_SOURCE,
  FLOW_NODE_OUTPUTS,
  flowNodeBranchKeys,
  type FlowDefinition,
  type FlowEdge,
  type FlowNode,
  type FlowValueType,
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
  validateBranchCoverage(definition.nodes, validEdges, errors);
  validateEntryAndTerminalNodes(definition.nodes, validEdges, errors);
  if (hasCycle(definition.nodes, validEdges)) {
    errors.push({
      path: 'edges',
      rule: 'cycle',
      message: 'Flow 不允许节点之间形成环；PlanLoop 的循环必须保留在节点内部',
    });
    return errors;
  }

  // 支配关系只在无环图上有意义，且需要唯一入口；两条前置都不满足时已经报过更准确的错，
  // 再算一遍支配集只会叠加噪音
  const entryNodeKey = findEntryNodeKey(definition.nodes, validEdges);
  if (!entryNodeKey) {
    return errors;
  }
  const dominators = computeDominators(
    definition.nodes,
    validEdges,
    entryNodeKey,
  );
  validatePlanPrerequisite(definition.nodes, dominators, errors);
  validateVariableReferences(definition.nodes, dominators, errors);
  return errors;
}

/**
 * 找出图的唯一入口节点
 * @param nodes 全部节点
 * @param edges 端点与分支均有效的边集合
 * @returns 恰好一个入口时返回其标识，否则返回 undefined
 */
function findEntryNodeKey(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
): string | undefined {
  const incoming = new Set(edges.map((edge) => edge.to));
  const entries = nodes.filter((node) => !incoming.has(node.id));
  return entries.length === 1 ? entries[0].id : undefined;
}

/**
 * 计算每个节点的支配集
 * @param nodes 全部节点
 * @param edges 端点与分支均有效的边集合
 * @param entryNodeKey 唯一入口节点标识
 * @returns 返回节点标识到其支配节点集合的映射，集合含节点自身
 * @description 支配集定义为「从入口到该节点的每一条路径上都必然出现的节点」，用经典迭代
 * 不动点求解：dom(entry) = {entry}，dom(n) = {n} ∪ (∩ dom(pred))。
 * 有了它，「引用必须指向必定已执行的节点」与「依赖计划的节点前面必定有 plan」这两条规则
 * 就是同一个事实的两次查询，不需要各写一份数据流。
 * 只对入口可达的节点求解：不可达节点已由 reachable-node 单独报错，把它们算进来会得到
 * 「支配集为全集」这种无意义结果并连带污染下游判定。
 */
function computeDominators(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  entryNodeKey: string,
): Map<string, ReadonlySet<string>> {
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    predecessors.set(edge.to, [
      ...(predecessors.get(edge.to) ?? []),
      edge.from,
    ]);
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
  }

  const reachable = new Set<string>();
  const pending = [entryNodeKey];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || reachable.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    pending.push(...(successors.get(nodeId) ?? []));
  }

  const allReachable = new Set(reachable);
  const dominators = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      continue;
    }
    // 初值取全集，交集迭代才能单调收缩到不动点；入口固定为自身
    dominators.set(
      node.id,
      node.id === entryNodeKey
        ? new Set([entryNodeKey])
        : new Set(allReachable),
    );
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.id === entryNodeKey || !reachable.has(node.id)) {
        continue;
      }
      const incoming = (predecessors.get(node.id) ?? []).filter((from) =>
        reachable.has(from),
      );
      let next: Set<string>;
      if (incoming.length === 0) {
        next = new Set([node.id]);
      } else {
        next = new Set(dominators.get(incoming[0]) ?? []);
        for (const from of incoming.slice(1)) {
          const other = dominators.get(from) ?? new Set<string>();
          for (const candidate of [...next]) {
            if (!other.has(candidate)) {
              next.delete(candidate);
            }
          }
        }
        next.add(node.id);
      }
      const current = dominators.get(node.id);
      if (!current || current.size !== next.size) {
        dominators.set(node.id, next);
        changed = true;
        continue;
      }
      for (const candidate of next) {
        if (!current.has(candidate)) {
          dominators.set(node.id, next);
          changed = true;
          break;
        }
      }
    }
  }

  return new Map(dominators);
}

/**
 * 检查依赖计划的节点前面是否必定存在 plan 节点
 * @param nodes 全部节点
 * @param dominators 每个节点的支配集
 * @param errors 用于累积校验错误的数组
 * @returns 无返回值
 * @description plan-loop 与 approval 在运行时都要读取 plan 节点写入的计划；缺少前置 plan 时
 * Activity 会抛 AGENT_FLOW_PLAN_STATE_MISSING 直接终止任务。这个错误必须在发布期就拦住，
 * 否则一个能通过发布校验的 Flow 会在每个终端用户身上炸。要求「每条路径上都有」而不是
 * 「存在一条路径有」：只要有一条绕开 plan 的分支，那条分支上的运行就会失败——而这正是
 * 支配集的定义，因此这里只是一次查询，不再自己走一遍数据流。
 */
function validatePlanPrerequisite(
  nodes: readonly FlowNode[],
  dominators: ReadonlyMap<string, ReadonlySet<string>>,
  errors: FlowDefinitionValidationError[],
): void {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node, index) => {
    if (node.type !== 'plan-loop' && node.type !== 'approval') {
      return;
    }
    const dominating = dominators.get(node.id);
    if (!dominating) {
      return;
    }
    const hasPlan = [...dominating].some(
      (candidate) =>
        candidate !== node.id && nodesById.get(candidate)?.type === 'plan',
    );
    if (hasPlan) {
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
 * 校验节点配置里的全部变量引用
 * @param nodes 全部节点
 * @param dominators 每个节点的支配集
 * @param errors 用于累积校验错误的数组
 * @returns 无返回值
 * @description 三件事一起查：被引来源存在、被引字段是该来源声明的输出、算子与该输出的类型匹配，
 * 以及最关键的 ref-dominates —— 引用只能指向支配本节点的节点。
 * 后者拦下两类错误：引用下游节点（拓扑序违规），以及**引用互斥条件分支里的节点**。
 * 第二类是变量模型最容易漏的坑：图上看着连通，运行时那条分支没走，取值必定为空。
 * 它在发布期可判定，就必须在发布期拦，而不是让终端用户在运行时拿到一个空值。
 */
function validateVariableReferences(
  nodes: readonly FlowNode[],
  dominators: ReadonlyMap<string, ReadonlySet<string>>,
  errors: FlowDefinitionValidationError[],
): void {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node, nodeIndex) => {
    if (node.type !== 'condition') {
      return;
    }
    node.config.cases.forEach((branch, caseIndex) => {
      branch.conditions.forEach((predicate, predicateIndex) => {
        const path = `nodes.${nodeIndex}.config.cases.${caseIndex}.conditions.${predicateIndex}`;
        const [sourceId, field] = predicate.ref.$ref;
        const valueType = resolveRefValueType(sourceId, field, nodesById);
        if (!valueType) {
          errors.push({
            path: `${path}.ref`,
            rule: 'ref-target',
            message: `引用「${sourceId}.${field}」不存在：来源必须是已声明该输出的节点或 ${FLOW_INPUT_SOURCE}`,
          });
          return;
        }
        if (sourceId !== FLOW_INPUT_SOURCE) {
          const dominating = dominators.get(node.id);
          if (!dominating?.has(sourceId) || sourceId === node.id) {
            errors.push({
              path: `${path}.ref`,
              rule: 'ref-dominates',
              message: `节点「${node.id}」不能引用「${sourceId}」：只允许引用到达本节点的每条路径上都必定已执行的节点`,
            });
            return;
          }
        }

        const operator = FLOW_CONDITION_OPERATORS[predicate.operator];
        if (!operator.valueTypes.includes(valueType)) {
          errors.push({
            path: `${path}.operator`,
            rule: 'ref-type-match',
            message: `算子「${predicate.operator}」不能用于 ${valueType} 类型的「${sourceId}.${field}」`,
          });
        }
        if (operator.requiresValue && predicate.value === undefined) {
          errors.push({
            path: `${path}.value`,
            rule: 'condition-value-required',
            message: `算子「${predicate.operator}」必须提供比较值`,
          });
        }
        if (!operator.requiresValue && predicate.value !== undefined) {
          errors.push({
            path: `${path}.value`,
            rule: 'condition-value-forbidden',
            message: `算子「${predicate.operator}」不接受比较值`,
          });
        }
      });
    });
  });
}

/**
 * 解析一个引用指向的输出类型
 * @param sourceId 被引来源标识，可能是节点标识或 Flow 级根变量
 * @param field 被引输出字段名
 * @param nodesById 节点索引
 * @returns 来源与字段都已声明时返回其值类型，否则返回 undefined
 * @description 输出声明是代码里的闭集常量，编辑器的变量选择器与这里用的是同一份事实。
 */
function resolveRefValueType(
  sourceId: string,
  field: string,
  nodesById: ReadonlyMap<string, FlowNode>,
): FlowValueType | undefined {
  if (sourceId === FLOW_INPUT_SOURCE) {
    return FLOW_INPUT_OUTPUTS[field];
  }
  const source = nodesById.get(sourceId);
  return source ? FLOW_NODE_OUTPUTS[source.type][field] : undefined;
}

/**
 * 校验分支覆盖的完备性
 * @param nodes 全部节点
 * @param edges 端点与分支均有效的边集合
 * @param errors 用于累积校验错误的数组
 * @returns 无返回值
 * @description 一个节点声明的分支要么全部有出边，要么全部没有（即它是终点）。
 * 不允许部分覆盖：漏掉的那条分支在运行时命中就无处可去，Flow 会在那里静默停住。
 */
function validateBranchCoverage(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  errors: FlowDefinitionValidationError[],
): void {
  const outgoingBranches = new Map<string, Set<string>>();
  for (const edge of edges) {
    const branches = outgoingBranches.get(edge.from) ?? new Set<string>();
    branches.add(edge.when ?? FLOW_DEFAULT_BRANCH);
    outgoingBranches.set(edge.from, branches);
  }

  nodes.forEach((node, index) => {
    const declared = flowNodeBranchKeys(node);
    const covered = outgoingBranches.get(node.id) ?? new Set<string>();
    if (covered.size === 0 || covered.size === declared.length) {
      return;
    }
    const missing = declared.filter((branch) => !covered.has(branch));
    errors.push({
      path: `nodes.${index}.id`,
      rule: 'branch-coverage',
      message: `节点「${node.id}」的分支「${missing.join('、')}」没有出边；分支必须全部连出或全部不连`,
    });
  });
}

/**
 * 判断边的分支标识是否为源节点声明的分支
 * @param node 边的源节点
 * @param when 用户声明的可选分支标识
 * @returns 当节点声明了该分支时返回 true
 * @description 合法取值不再由类型系统枚举，而由 flowNodeBranchKeys 这一份共享事实决定；
 * `when` 缺省等价于 default 分支。
 */
function isValidEdgeWhen(node: FlowNode, when: string | undefined) {
  return flowNodeBranchKeys(node).includes(when ?? FLOW_DEFAULT_BRANCH);
}

/**
 * 检查一个源节点是否重复声明相同分支
 * @param edges 端点和分支均有效的边集合
 * @param errors 用于累积校验错误的数组
 * @returns 无返回值
 * @description 同一默认边或同一 approval 分支只能出现一次，防止运行时无法确定下一跳。
 */
function validateDuplicateBranches(
  edges: readonly FlowEdge[],
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
  edges: readonly FlowEdge[],
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
  edges: readonly FlowEdge[],
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
