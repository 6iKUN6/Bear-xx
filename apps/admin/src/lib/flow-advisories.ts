import { FLOW_DEFAULT_BRANCH } from "@litter-bear/types/agent-flow";
import {
  branchKeysOf,
  type EditableDefinition,
  type EditableNode,
} from "@/lib/flow-edit";

/** 一条编辑期提示；`nodeId` 有值时可在画布上定位到具体节点。 */
export interface FlowAdvisory {
  /** 稳定标识，用于列表 key 与去重 */
  id: string;
  /** 相关节点；图级问题为空 */
  nodeId?: string;
  /** 一句话说清「什么不对」 */
  title: string;
  /** 说清「为什么这是问题」以及怎么改 */
  detail: string;
}

/**
 * 会向客户端产出回复正文的节点类型
 * @description 与服务端 `concurrent-answer-nodes` 用的是同一个判据。
 */
const TEXT_PRODUCING = new Set(["agent", "synthesize"]);

/**
 * 算出当前草稿的编辑期提示
 * @param definition 当前草稿
 * @returns 返回提示列表；没有问题时为空数组
 * @description **提示不是拒绝。** 服务端校验负责拦「非法」的图（`unique-start` / `cycle` /
 * `ref-dominates` / `concurrent-answer-nodes` 等），这里负责提醒「合法但大概率不是本意」。
 * 两者刻意分开：把提示做成拒绝会挡掉合法用法。
 *
 * 触发这件事的真实案例：start 扇出两个 agent → `join(any)` → synthesize。图完全合法、
 * 跑通了，但 `any` 的语义是「任一完成即继续」，于是第二个 agent 那 52 秒的工作被完全丢弃，
 * 而 synthesize 只拿到一个分支的结果。这类问题服务端不该拒绝（`any` 是合法配置），但编辑时
 * 应该说出来。
 *
 * 刻意**不**在这里复刻服务端的图级规则：互斥性判定依赖服务端 validator 里的
 * `isMutuallyExclusive`，前端复刻就是两份事实源，且判错会挡掉合法图。
 *
 * 将来若要加基于「必定已完成」的提示，用 `packages/types` 里那一份 `flowMustCompleteBefore`
 * （前后端共用），并注意它在**入口不唯一时返回空映射**——草稿常处于这种中间态，必须把
 * 「算不出来」和「有问题」区分开。
 */
export function flowAdvisories(
  definition: EditableDefinition,
): FlowAdvisory[] {
  const advisories: FlowAdvisory[] = [];
  const { nodes, edges } = definition;

  advisories.push(...detachedNodes(nodes, edges));
  advisories.push(...uncoveredBranches(nodes, edges));
  advisories.push(...deadEndPaths(nodes, edges));
  advisories.push(...discardedJoinBranches(definition));
  advisories.push(...budgetTooTight(definition));

  return advisories;
}

/**
 * 未连线的孤立节点
 * @description 服务端的 `reachable-node` 会拒，但那要等到点保存。加了节点忘了连线是最常见的
 * 中间态，就地提示比攒到保存时更有用。
 */
function detachedNodes(
  nodes: EditableNode[],
  edges: EditableDefinition["edges"],
): FlowAdvisory[] {
  const touched = new Set<string>();
  for (const edge of edges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }
  return nodes
    .filter((node) => node.type !== "start" && !touched.has(node.id))
    .map((node) => ({
      id: `detached:${node.id}`,
      nodeId: node.id,
      title: `节点「${node.name || node.id}」还没有连线`,
      detail: "它不会被执行；连上上游后才会进入流程。保存时服务端也会拒绝孤立节点。",
    }));
}

/**
 * 具名分支没连出去
 * @description condition 的某个 case 或 approval 的某个决定没连边——命中那条分支时流程会
 * 直接停在这里。服务端的 `branch-coverage` 拒的是完全没覆盖，但「漏了一个 case」在编辑
 * 过程中更常见，且从画布上不容易看出来。
 */
function uncoveredBranches(
  nodes: EditableNode[],
  edges: EditableDefinition["edges"],
): FlowAdvisory[] {
  const advisories: FlowAdvisory[] = [];
  for (const node of nodes) {
    const declared = branchKeysOf(node);
    if (declared.length <= 1) {
      continue;
    }
    const covered = new Set(
      edges
        .filter((edge) => edge.from === node.id)
        .map((edge) => edge.when ?? FLOW_DEFAULT_BRANCH),
    );
    const missing = declared.filter((key) => !covered.has(key));
    if (missing.length === 0) {
      continue;
    }
    advisories.push({
      id: `uncovered:${node.id}`,
      nodeId: node.id,
      title: `节点「${node.name || node.id}」有分支没连出去：${missing.join("、")}`,
      detail:
        "命中这些分支时流程会停在这里，不再往下走，用户拿不到回复。要么连出去，要么删掉对应的 case。",
    });
  }
  return advisories;
}

/**
 * 走到底却产不出回复的路径
 * @description 终节点不是 agent / synthesize，意味着那条路走完也没有正文——运行时约定只有
 * 终节点产出这条助手消息的正文（见 `agent-flow-as-single-runtime.md`）。服务端不拒这种图，
 * 但它几乎一定不是本意。
 */
function deadEndPaths(
  nodes: EditableNode[],
  edges: EditableDefinition["edges"],
): FlowAdvisory[] {
  const hasOutgoing = new Set(edges.map((edge) => edge.from));
  const touched = new Set<string>();
  for (const edge of edges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }
  return nodes
    .filter(
      (node) =>
        !hasOutgoing.has(node.id) &&
        // 孤立节点已由 detachedNodes 单独提示，不重复报
        touched.has(node.id) &&
        !TEXT_PRODUCING.has(node.type),
    )
    .map((node) => ({
      id: `deadend:${node.id}`,
      nodeId: node.id,
      title: `路径终点「${node.name || node.id}」不会产出回复`,
      detail:
        "只有图的终节点会产出这条助手消息的正文，而它不是 agent 或 synthesize，所以走到这里用户拿不到回答。后面接一个 agent 或 synthesize 节点。",
    }));
}

/**
 * `join(any)` 下被丢弃的分支产出
 * @description 这是触发整个提示机制的那个真实案例。`any` 的语义是「任一完成即继续」，未被等到
 * 的分支会照常跑完但产出无人使用；而下游也**不能**用 `$ref` 引用它们（`flowMustCompleteBefore`
 * 在 `any` 下只保证公共前置，服务端 `ref-dominates` 会拒）。
 *
 * 这不是错误：想要「谁快用谁」时 `any` 正是对的。所以只提示，不拒绝。
 */
function discardedJoinBranches(
  definition: EditableDefinition,
): FlowAdvisory[] {
  const advisories: FlowAdvisory[] = [];
  for (const node of definition.nodes) {
    if (node.type !== "join") {
      continue;
    }
    const policy = node.config.policy;
    const waitFor = Array.isArray(node.config.waitFor)
      ? node.config.waitFor.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    if (policy !== "any" || waitFor.length < 2) {
      continue;
    }
    advisories.push({
      id: `joinany:${node.id}`,
      nodeId: node.id,
      title: `汇聚节点「${node.name || node.id}」用的是「任一完成即继续」`,
      detail: `等待的 ${waitFor.length} 条分支里只有最先完成的那条会被用到，其余会照常跑完但产出被丢弃，下游也无法引用它们的输出。想汇总全部分支请改成「等齐全部」。`,
    });
  }
  return advisories;
}

/**
 * 预算撑不住图的规模
 * @description `maxModelCalls` 小于图上会调模型的节点数时，必然中途以 budget_exceeded 中断。
 * 这个下界很粗（plan-loop 一个节点就会调很多次），所以只在**必然撞线**时才提示，避免噪音。
 */
function budgetTooTight(definition: EditableDefinition): FlowAdvisory[] {
  const policy = definition.policy;
  const maxModelCalls =
    typeof policy === "object" && policy !== null
      ? (policy as { maxModelCalls?: unknown }).maxModelCalls
      : undefined;
  if (typeof maxModelCalls !== "number") {
    return [];
  }
  const modelNodes = definition.nodes.filter((node) =>
    ["agent", "synthesize", "plan", "plan-loop"].includes(node.type),
  ).length;
  if (modelNodes <= maxModelCalls) {
    return [];
  }
  return [
    {
      id: "budget:model-calls",
      title: `模型调用预算（${maxModelCalls}）小于会调模型的节点数（${modelNodes}）`,
      detail:
        "这张图必然在跑完之前撞上预算上限并以「已达运行预算上限」中断。调高 policy.maxModelCalls，或减少调模型的节点。",
    },
  ];
}

