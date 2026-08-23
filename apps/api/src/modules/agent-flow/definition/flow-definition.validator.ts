import {
  FLOW_CONDITION_OPERATORS,
  FLOW_DEFAULT_BRANCH,
  FLOW_NODE_OUTPUTS,
  flowMustCompleteBefore,
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
  validateStartNode(definition.nodes, validEdges, errors);
  validateJoinNodes(definition.nodes, validEdges, errors);
  validateEntryAndTerminalNodes(definition.nodes, validEdges, errors);
  if (hasCycle(definition.nodes, validEdges)) {
    errors.push({
      path: 'edges',
      rule: 'cycle',
      message: 'Flow 不允许节点之间形成环；PlanLoop 的循环必须保留在节点内部',
    });
    return errors;
  }

  // 「必定已完成」分析只在无环图上有意义；入口唯一性由它自己判定，入口不唯一时返回空映射，
  // 而那种情况已经由 unique-entry / unique-start 报过更准确的错，不再叠加噪音
  const dominators = flowMustCompleteBefore(definition.nodes, validEdges);
  if (dominators.size === 0) {
    return errors;
  }
  validateVariableReferences(definition.nodes, dominators, errors);
  return errors;
}

/**
 * 校验起始节点
 * @param nodes 全部节点
 * @param edges 端点与分支均有效的边集合
 * @param errors 用于累积校验错误的数组
 * @returns 无返回值
 * @description 入口从「推导」改为「声明」：原先靠「没有入边的那个节点」推断入口，用户在画布上
 * 删掉一条边就会静默多出一个入口，报错也只说「入口节点为 2 个」，指不到是谁。
 * start 同时是变量模型的锚点——用户本轮消息由它的 `text` 输出提供，因此引用机制只剩节点输出
 * 一套，不再需要 `$input` 这个凭空存在的来源。
 */
function validateStartNode(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  errors: FlowDefinitionValidationError[],
): void {
  const startNodes = nodes.filter((node) => node.type === 'start');
  if (startNodes.length !== 1) {
    errors.push({
      path: 'nodes',
      rule: 'unique-start',
      message: `Flow 必须有且仅有一个 start 节点，当前为 ${startNodes.length} 个`,
    });
    return;
  }
  const incoming = new Set(edges.map((edge) => edge.to));
  if (incoming.has(startNodes[0].id)) {
    errors.push({
      path: 'nodes',
      rule: 'start-is-entry',
      message: `start 节点「${startNodes[0].id}」不能有入边`,
    });
  }
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
    validateConfigRefs(node, nodeIndex, nodesById, dominators, errors);
  });

  nodes.forEach((node, nodeIndex) => {
    if (node.type !== 'condition') {
      return;
    }
    node.config.cases.forEach((branch, caseIndex) => {
      branch.conditions.forEach((predicate, predicateIndex) => {
        const path = `nodes.${nodeIndex}.config.cases.${caseIndex}.conditions.${predicateIndex}`;
        const valueType = checkRef(
          predicate.ref,
          node,
          `${path}.ref`,
          nodesById,
          dominators,
          errors,
        );
        if (!valueType) {
          return;
        }

        const operator = FLOW_CONDITION_OPERATORS[predicate.operator];
        if (!operator.valueTypes.includes(valueType)) {
          errors.push({
            path: `${path}.operator`,
            rule: 'ref-type-match',
            message: `算子「${predicate.operator}」不能用于 ${valueType} 类型的「${predicate.ref.$ref.join('.')}」`,
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
 * 校验一个节点 config 上声明的引用
 * @param node 当前节点
 * @param nodeIndex 节点在数组中的下标，用于拼错误路径
 * @param nodesById 节点索引
 * @param dominators 每个节点的支配集
 * @param errors 用于累积校验错误的数组
 * @returns 无返回值
 * @description plan-loop 与 approval 用 planRef 指明要执行/审批哪份计划，synthesize 用
 * observationsRef 指明汇总谁的观察。这几条替代了原先的 `plan-prerequisite` 规则——那条规则
 * 只能表达「前面某处有个 plan 节点」，图上有两个 plan 时根本说不清用哪个；改成显式引用后，
 * 「被引节点必定已执行」由通用的 ref-dominates 保证，更准也更少一条特例。
 */
function validateConfigRefs(
  node: FlowNode,
  nodeIndex: number,
  nodesById: ReadonlyMap<string, FlowNode>,
  dominators: ReadonlyMap<string, ReadonlySet<string>>,
  errors: FlowDefinitionValidationError[],
): void {
  if (node.type === 'plan-loop') {
    requireArrayRef(
      node.config.planRef,
      'steps',
      node,
      `nodes.${nodeIndex}.config.planRef`,
      nodesById,
      dominators,
      errors,
    );
    return;
  }
  if (node.type === 'approval') {
    const path = `nodes.${nodeIndex}.config.planRef`;
    const ok = requireArrayRef(
      node.config.planRef,
      'steps',
      node,
      path,
      nodesById,
      dominators,
      errors,
    );
    // 重规划要复用 plan 节点 config 里的 maxSteps，因此审批只能挂在 plan 节点上；
    // 指向另一个 approval 的 steps 会让「按多少步重规划」无处可取
    if (ok && nodesById.get(node.config.planRef.$ref[0])?.type !== 'plan') {
      errors.push({
        path,
        rule: 'approval-plan-source',
        message: `计划审批只能引用 plan 节点的 steps，当前引用的是「${node.config.planRef.$ref[0]}」`,
      });
    }
    return;
  }
  if (node.type === 'synthesize' && node.config.observationsRef) {
    requireArrayRef(
      node.config.observationsRef,
      'observations',
      node,
      `nodes.${nodeIndex}.config.observationsRef`,
      nodesById,
      dominators,
      errors,
    );
  }
}

/**
 * 校验一个引用必须指向某个数组输出
 * @param ref 待校验引用
 * @param expectedField 期望的输出字段名
 * @param node 声明该引用的节点
 * @param path 错误路径
 * @param nodesById 节点索引
 * @param dominators 每个节点的支配集
 * @param errors 用于累积校验错误的数组
 * @returns 通过时返回 true
 * @description 字段名固定：planRef 只能指 `steps`、observationsRef 只能指 `observations`。
 * 允许指向任意数组输出会让运行时拿到一个形状对不上的数组，而那种错在发布期看不出来。
 */
function requireArrayRef(
  ref: { $ref: readonly [string, string] },
  expectedField: string,
  node: FlowNode,
  path: string,
  nodesById: ReadonlyMap<string, FlowNode>,
  dominators: ReadonlyMap<string, ReadonlySet<string>>,
  errors: FlowDefinitionValidationError[],
): boolean {
  const valueType = checkRef(ref, node, path, nodesById, dominators, errors);
  if (!valueType) {
    return false;
  }
  if (ref.$ref[1] !== expectedField) {
    errors.push({
      path,
      rule: 'ref-field',
      message: `此处只能引用「${expectedField}」输出，当前引用的是「${ref.$ref[1]}」`,
    });
    return false;
  }
  return true;
}

/**
 * 校验引用的来源与可达性
 * @param ref 待校验引用
 * @param node 声明该引用的节点
 * @param path 错误路径
 * @param nodesById 节点索引
 * @param dominators 每个节点的支配集
 * @param errors 用于累积校验错误的数组
 * @returns 通过时返回被引输出的值类型，否则返回 undefined
 * @description condition 的判定与节点 config 上的引用共用这一份检查，避免两处各写一遍
 * ref-target / ref-dominates 后语义漂移。
 */
function checkRef(
  ref: { $ref: readonly [string, string] },
  node: FlowNode,
  path: string,
  nodesById: ReadonlyMap<string, FlowNode>,
  dominators: ReadonlyMap<string, ReadonlySet<string>>,
  errors: FlowDefinitionValidationError[],
): FlowValueType | undefined {
  const [sourceId, field] = ref.$ref;
  const valueType = resolveRefValueType(sourceId, field, nodesById);
  if (!valueType) {
    errors.push({
      path,
      rule: 'ref-target',
      message: `引用「${sourceId}.${field}」不存在：来源必须是已声明该输出的节点`,
    });
    return undefined;
  }
  const dominating = dominators.get(node.id);
  if (!dominating?.has(sourceId) || sourceId === node.id) {
    errors.push({
      path,
      rule: 'ref-dominates',
      message: `节点「${node.id}」不能引用「${sourceId}」：只允许引用到达本节点的每条路径上都必定已执行的节点`,
    });
    return undefined;
  }
  return valueType;
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
    const branch = edge.when ?? FLOW_DEFAULT_BRANCH;
    // default 分支允许多条出边：那就是并行扇出，全部并发启动。
    // 具名分支仍然唯一——condition 的一个 case 有两条出边时，运行时无法确定走哪条。
    if (branch === FLOW_DEFAULT_BRANCH) {
      const target = `${edge.from}->${edge.to}`;
      if (seen.has(target)) {
        errors.push({
          path: `edges.${index}`,
          rule: 'duplicate-edge',
          message: `节点「${edge.from}」到「${edge.to}」的默认边重复`,
        });
        return;
      }
      seen.add(target);
      return;
    }
    const branchKey = `${edge.from}:${branch}`;
    if (seen.has(branchKey)) {
      errors.push({
        path: `edges.${index}`,
        rule: 'unique-edge-branch',
        message: `节点「${edge.from}」的分支「${branch}」重复`,
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

/**
 * 校验 join 节点
 * @param nodes 全部节点
 * @param edges 端点与分支均有效的边集合
 * @param errors 用于累积校验错误的数组
 * @returns 无返回值
 * @description 三条：waitFor 里的节点必须存在、必须真的连到本 join（否则等一个永远不会到达的
 * 分支就是死锁），以及 `policy: "all"` 时不能等待处于**互斥 case 分支**下的两个节点——那同样
 * 必然死锁，而且这件事在发布期可判定，因为 case 划分是静态的。
 */
function validateJoinNodes(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  errors: FlowDefinitionValidationError[],
): void {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const mustComplete = flowMustCompleteBefore(nodes, edges);
  nodes.forEach((node, index) => {
    if (node.type !== 'join') {
      return;
    }
    const path = `nodes.${index}.config.waitFor`;
    if (node.config.waitFor.length === 0) {
      errors.push({
        path,
        rule: 'join-wait-for',
        message: `join 节点「${node.id}」必须至少等待一个节点`,
      });
      return;
    }
    const incomingFrom = new Set(
      edges.filter((edge) => edge.to === node.id).map((edge) => edge.from),
    );
    for (const target of node.config.waitFor) {
      if (!nodeIds.has(target)) {
        errors.push({
          path,
          rule: 'join-wait-for',
          message: `join 节点「${node.id}」等待的「${target}」不存在`,
        });
        continue;
      }
      if (!incomingFrom.has(target)) {
        errors.push({
          path,
          rule: 'join-wait-for',
          message: `join 节点「${node.id}」等待的「${target}」没有连到它；等一个不会到达的分支即死锁`,
        });
      }
    }
    if (node.config.policy !== 'all') {
      return;
    }
    const waits = node.config.waitFor.filter((target) => nodeIds.has(target));
    for (let i = 0; i < waits.length; i += 1) {
      for (let j = i + 1; j < waits.length; j += 1) {
        if (
          isMutuallyExclusive(waits[i], waits[j], nodes, edges, mustComplete)
        ) {
          errors.push({
            path,
            rule: 'join-exclusive-branches',
            message: `join 节点「${node.id}」以 all 等待「${waits[i]}」与「${waits[j]}」，但它们处于互斥分支，必然死锁`,
          });
        }
      }
    }
  });
}

/**
 * 判断两个节点是否处于互斥的 condition 分支下
 * @param left 待比较节点
 * @param right 待比较节点
 * @param nodes 全部节点
 * @param edges 端点与分支均有效的边集合
 * @param mustComplete 每个节点的必完成集合
 * @returns 处于互斥分支时返回 true
 * @description 判据是「存在一个 condition 节点，它的两条**不同**分支分别只通向其中一个」。
 * 用可达性算：从 condition 的每条出边分别走一遍，若 left 只出现在某一条、right 只出现在另一条，
 * 两者就永不同时执行。并行扇出的 default 边不算互斥——那是全都会走的。
 */
function isMutuallyExclusive(
  left: string,
  right: string,
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  mustComplete: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  // 互相有保证的两个节点必然不互斥，先便宜地排掉
  if (
    mustComplete.get(left)?.has(right) ||
    mustComplete.get(right)?.has(left)
  ) {
    return false;
  }
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
  }
  const reachFrom = (start: string): Set<string> => {
    const seen = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || seen.has(current)) {
        continue;
      }
      seen.add(current);
      pending.push(...(successors.get(current) ?? []));
    }
    return seen;
  };

  for (const node of nodes) {
    if (node.type !== 'condition') {
      continue;
    }
    const branches = edges.filter((edge) => edge.from === node.id);
    for (let i = 0; i < branches.length; i += 1) {
      for (let j = i + 1; j < branches.length; j += 1) {
        const a = reachFrom(branches[i].to);
        const b = reachFrom(branches[j].to);
        if (
          (a.has(left) && b.has(right) && !a.has(right) && !b.has(left)) ||
          (a.has(right) && b.has(left) && !a.has(left) && !b.has(right))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}
