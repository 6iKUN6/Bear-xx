# 图上的循环

**状态**：运行时循环已实施。本文保留实施前的问题分析与落地步骤；其中代码行号和“当前”
描述应按历史上下文理解。主画布 Loop 容器、显式 `loopId` 与 v9 → v10 升级见
`docs/superpowers/specs/2026-09-10-agent-flow-loop-container-design.md`。

本文只回答「图上怎么表达循环」。V2 的并行 / 变量 / 条件模型见 `agent-flow-v2-model.md`（§4.6 记录了「不做环」这个决定被推翻的过程），运行时分层见 `agent-flow-architecture.md`。

## 0. 为什么 plan-loop 不够

`plan-loop` 表达的是「按一份已生成的计划逐步执行」，循环边界在节点内部、轮数等于计划步数。它表达不了：

- **重试到满足条件**：生成 → 检查 → 不合格就重来
- **对一批数据逐个处理**：轮数由上游输出的数组长度决定
- **由条件而非计划决定继续与否**

用户的原话是「手动实现循环的逻辑，还有预设的可用循环节点」。

## 1. 三个必须先知道的现有约束

**这一节是全文的地基。** 下面每一条都是当前代码的事实，不是推测；循环设计如果绕过其中任何一条，会在运行时以难查的方式失败。

### 1.1 `nodeExecutionId` 不含轮次

```ts
// agent-flow.workflow.ts:444
function createNodeExecutionId(input, nodeKey) {
  return `${input.streamTaskId}:${input.flowVersionId}:${nodeKey}`;
}
```

它是 `AgentFlowNodeExecution` 的唯一键组成部分（`@@unique([taskId, nodeExecutionId])`）。

**后果**：同一个 nodeKey 跑第二轮时写入会撞唯一约束。

### 1.2 幂等短路会把「第 2 轮」误判成「已完成」

```ts
// agent-flow.activities.ts:344 replayFinishedNode
const execution = await this.prisma.agentFlowNodeExecution.findUnique({
  where: { taskId_nodeExecutionId: { taskId, nodeExecutionId } },
});
if (execution) {
  return toReplayedNodeResult(execution, ...);   // 直接返回，不执行节点
}
```

这个短路是为 Temporal 重试设计的：节点事务已提交而结果上报丢失时，重试要回放同一结果而不是重跑模型与工具。

**后果**：循环第 2 轮进来，`nodeExecutionId` 与第 1 轮相同，于是**直接返回第 1 轮的结果、根本不执行**。循环会立刻退化成「只跑一轮」，而且没有任何报错。

⚠️ **这是整个改动里风险最高的一处。** 它同时也是安全机制：改错的另一个方向是让重试**重复执行已放行的工具**（外部副作用，比如下单）。两个方向都不能错。

### 1.3 `$ref` 按 nodeKey 取值，且读取顺序不确定

```ts
// agent-flow.activities.ts:1266 loadUpstreamOutputs
const rows = await this.prisma.agentFlowNodeExecution.findMany({
  where: { taskId },
  select: { nodeKey: true, outputs: true },
});                                    // ← 没有 orderBy
const outputs = new Map<string, Prisma.JsonObject>();
for (const row of rows) {
  outputs.set(row.nodeKey, row.outputs);   // ← 同一 nodeKey 后写覆盖前写
}
```

**后果**：循环下同一 nodeKey 有多行，Map 只留一条，而留哪条取决于数据库返回顺序——**没有 `orderBy` 就没有保证**。`$ref` 会取到不确定轮次的输出。

这个 bug 不会报错，只会让结果偶发不对。

### 1.4 前沿执行器的两个集合假设「一个节点最多跑一次」

```ts
// agent-flow.workflow.ts
const completed = new Set<string>();   // 用于 join gate 判定
const scheduled = new Set<string>();   // 防重复调度
...
for (const target of candidates) {
  if (scheduled.has(target)) continue;   // ← 靠这个假设去重
  ...
}
```

**后果**：`scheduled` 的去重语义与「同一节点可再次执行」直接矛盾。

## 2. 建议的设计

### 2.1 节点形态：`loop` 节点 + 显式回边

```
        ┌──────────────────────────────┐
        ↓                              │ back edge (when: "again")
start → loop ──body──→ agent → check ──┘
          │
          └──done──→ synthesize
```

`loop` 节点是循环的**唯一入口与出口**：

```ts
interface FlowLoopNodeConfig {
  /** 最大轮数，必填且有上限——没有硬上限等于把死循环兜底完全交给预算 */
  readonly maxIterations: number;
  /**
   * 继续循环的判定
   * @description 复用 condition 节点的 cases 形状，不新造一套判定语法。
   * 命中即走 `again` 分支，否则走 `done`。
   */
  readonly continueWhen: readonly FlowConditionCase[];
}
```

分支键：`again`（进入循环体）/ `done`（退出）。

**为什么循环边界要显式成一个节点**，而不是允许任意回边：

- 校验器能判定「哪些节点在循环体内」——那是放开 `cycle` 规则的前提
- 轮次计数有明确归属（挂在 loop 节点上）
- 前沿执行器只需在一处处理「重置循环体的 scheduled 状态」

### 2.2 轮次进入标识：`nodeExecutionId` 加轮次段

```
现在：  {taskId}:{flowVersionId}:{nodeKey}
改为：  {taskId}:{flowVersionId}:{nodeKey}#{iteration}
```

`iteration` 是**所在循环体的轮次**，不在任何循环体内的节点固定为 `0`（因此非循环图的 id 形状不变，历史数据不受影响）。

这一条同时解决 §1.1 与 §1.2：

- 唯一键不再冲突
- `replayFinishedNode` 查到的是「本轮」的记录，第 2 轮不会命中第 1 轮 → 循环真的会执行，而 Temporal 重试仍然回放同一轮的结果，**工具副作用的保护不变**

⚠️ 实施时必须验证的是**后半句**：加了轮次段之后，Temporal 重试同一轮时 `nodeExecutionId` 必须完全一致。如果轮次是从数据库当前状态推算的（而不是由 Workflow 传下来的确定值），重试就会算出不同的轮次、绕过短路、重复执行工具。**轮次必须由 Workflow 侧持有并随 Activity 输入下传**，与 `nodeExecutionId` 现在的产生方式保持一致（Workflow 生成、Activity 只消费）。

### 2.3 迭代上下文：`$ref` 只能引用「最近一轮」

不引入轮次下标语法（`{ $ref: ['gen', 'text', -1] }` 这类），理由是它会渗进 `FlowRef` 契约、校验器、画布变量选择器三处，而实际需求几乎只有「上一轮的结果」。

改法是**给 `loadUpstreamOutputs` 补上确定的顺序与去重**：

```ts
const rows = await this.prisma.agentFlowNodeExecution.findMany({
  where: { taskId },
  select: { nodeKey: true, outputs: true, createdAt: true },
  orderBy: { createdAt: 'asc' },      // ← 补上确定顺序
});
// 同一 nodeKey 后写覆盖前写 ⇒ Map 里留下的是最近一轮
```

语义变成：**`$ref` 取被引节点最近一次完成的输出**。这对非循环图与现在完全等价（每个 nodeKey 只有一行），对循环图是「上一轮」。

`createdAt` 精度是毫秒，同一毫秒内两行的顺序仍不确定。因此实际实现应按 `nodeExecutionId` 里的轮次段排序，或给表加一个自增序列列——**这一点必须在实施时定死，不能留给数据库返回顺序**。

### 2.4 前沿执行器：进入新一轮时清除循环体的 `scheduled`

`loop` 节点走 `again` 分支时：

1. 轮次 +1
2. 把**循环体内所有节点**从 `scheduled` 与 `completed` 中移除
3. 按新轮次调度循环体入口

「循环体内有哪些节点」由校验期算出并写进运行快照（`toRunSnapshot`），Workflow 不做图分析——它现在也只查表不算图，保持这个分工。

`completed` 也要清除，因为它服务 join gate 判定：循环体内如果有 join，第 2 轮必须重新等待。

### 2.5 预算是唯一的死循环兜底，必须验证它够硬

`maxIterations` 防的是「配置写错」，防不住「每轮消耗巨大」。真正的兜底是 `policy.maxModelCalls` / `maxToolCalls` / `maxDurationSeconds`。

现有的预算判定是 Workflow 侧「软刹车」（撞线后不再扩展前沿、已在飞的允许跑完，见 `agent-flow-v2-model.md` §4.4）。**实施时要用真实用例验证**：一个故意不收敛的循环图，必须被预算终止并以 `budget_exceeded` 收敛，而不是跑到 Temporal 的 workflow 超时。

### 2.6 校验器：`cycle` 从「硬拒」改为「只允许被 loop 圈起来的环」

现在（`flow-definition.validator.ts:120`）：

```ts
if (hasCycle(definition.nodes, validEdges)) {
  errors.push({ path: 'edges', rule: 'cycle', ... });
}
```

改为：先识别出所有 `loop` 节点的循环体，再检查是否存在**不属于任何循环体**的环。

新增规则（建议名）：

| 规则 | 拒绝的情形 | 理由 |
| --- | --- | --- |
| `loop-back-edge` | 回边的终点不是它所属的 `loop` 节点 | 否则轮次归属不明 |
| `loop-body-reachable` | 循环体内有节点从 `again` 分支不可达 | 死代码，且会让「清除 scheduled」的范围失真 |
| `loop-nesting` | 嵌套循环（第一版直接拒） | 嵌套要处理「内层轮次归属外层哪一轮」，先不做 |
| `loop-ref-across` | 循环体外的节点引用循环体内节点的输出 | 那个值取决于最后一轮，语义含糊；要用就先经 `loop` 节点的声明输出透出 |

`flowMustCompleteBefore`（`packages/types/src/agent-flow/definition.ts`）也要处理环——它现在假设 DAG。**这个函数前后端共用**（后端 `ref-dominates`、画布变量选择器），改它两端都受影响，改动要同时验证两侧。

### 2.7 循环预设

用户要的第二件事。建议内置一个模板展示最典型的用法：

```
「生成 → 评估 → 不合格重来（最多 3 轮）」
start → loop ──again──→ generate(agent) → evaluate(agent)
          │                                     │
          │←────────────────────────────────────┘
          └──done──→ answer(synthesize)
```

`loop.continueWhen` 判定 `evaluate` 的输出是否表示「不合格」。

## 3. 实施顺序

每步可独立验证。**第 2 步是风险最高的一步，必须单独成一个 commit 并单独回归。**

**第 1 步 · 契约先行**
- `packages/types/src/agent-flow/definition.ts` 加 `loop` 节点类型与 `FlowLoopNodeConfig`
- `FLOW_NODE_OUTPUTS` 给 loop 声明输出（至少 `iteration`）
- `flowNodeBranchKeys` 加 `again` / `done`
- `AGENT_FLOW_SCHEMA_VERSION` 递增
- 编译器 / 校验器 / activities 的穷尽 switch 会全部报错——按报错清单逐个补，这正是闭集设计的用处

**第 2 步 · 幂等键加轮次段** ⚠️
- `createNodeExecutionId` 加 `#{iteration}`
- 轮次由 Workflow 持有并随 Activity 输入下传（**不要在 Activity 里从数据库推算**，见 §2.2）
- 验证两件事，缺一不可：
  1. 循环第 2 轮真的执行（不被 `replayFinishedNode` 短路）
  2. Temporal 重试同一轮时**仍然**被短路，工具不重复执行
- 递增 `AGENT_FLOW_WORKFLOW_REVISION`（命令序列变化）

**第 3 步 · `$ref` 取最近一轮**
- `loadUpstreamOutputs` 补确定顺序（§2.3，注意毫秒精度问题）
- 非循环图行为必须完全不变——用现有用例回归

**第 4 步 · 前沿执行器支持重入**
- 快照带上「循环体成员」
- `again` 分支时清除循环体的 `scheduled` / `completed`
- 用真实 Temporal 集成用例验证：多轮、循环体内含并行、循环体内含 join

**第 5 步 · 校验器规则**
- `cycle` 放开 + §2.6 的四条新规则
- `flowMustCompleteBefore` 处理环（**前后端共用，两侧都要验**）

**第 6 步 · 预算兜底验证**
- 故意不收敛的循环图必须以 `budget_exceeded` 收敛（§2.5）

**第 7 步 · 画布**
- 允许画回边；`flow-edit.ts` 的 `connect` 现在拒绝任何成环的连线
- loop 节点的 inspector（`maxIterations` + `continueWhen`）
- 内置循环模板

## 4. 第一版明确不做

- **嵌套循环**：内层轮次归属外层哪一轮，需要一套轮次路径而不是单个整数
- **轮次下标引用**（`$ref` 指定第 N 轮）：渗透面大，实际需求少
- **并行循环**（同一循环体多轮同时跑）：与预算判定和 `$ref` 语义都冲突
- **循环体内的 approval**：一个循环里反复弹审批，产品语义先想清楚再做；第一版建议由校验器拒绝
