# AgentFlow V2 数据模型设计（变量 / 分支 / 并行）

> 状态：**设计底本，未落代码**。V1（`schemaVersion: 1`）已在运行，本文描述通往「Dify 式画布编排」所需的模型改动。
> 日期：2026-08-20。
> 范围：`packages/types/src/agent-flow` 的 Definition 契约、`apps/api` 的 validator / compiler / Temporal 执行器与持久化。不含 admin 画布实现细节。
> 关联：`agent-flow-architecture.md`（V1 架构）、`agent-flow-iterations.md`、`hitl.md`。

## 0. 为什么需要 V2

产品目标是让管理员在画布上自由编排 flow（Dify 形态），其中**并行扇出是明确需求**。

V1 的合法图**必然是一条直链**，这不是实现遗漏，是校验器推出来的结果：

- `isValidEdgeWhen`（`flow-definition.validator.ts`）：非 approval 节点的 `when` 必须是 `undefined`，approval 必须是 `'approved'`
- `validateDuplicateBranches` 的去重键是 `${edge.from}:${edge.when ?? 'default'}`
- 两条合起来 ⇒ 每个节点的合法 `when` 只有一个取值 ⇒ **出度 ≤ 1**
- 出度 ≤ 1 + 无环 + 单入口 ⇒ 不存在菱形（菱形需要一个出度为 2 的节点）⇒ **入度也 ≤ 1**

所以 V1 图 = 单链。在此之上做自由连线画布，等于把后端 100% 会拒绝的操作做成可点的按钮。

需要澄清一个历史判断：V1 曾有 `condition` 节点，已在 2026-08 移除。移除是对的，但**不能简单恢复**——它的 `config.field` 是自由字符串，运行时只认 `started` 与 `hasPendingApproval` 两个名字，而这两个在求值点上都是常量（`started` 恒真，因为 `emitRunAndNodeStarted` 先写它；`hasPendingApproval` 恒假，因为节点只有清掉审批才会完成），任何其他字段名静默走 false 分支。那是一个永远算不对的 stub，V2 的条件分支要重新设计（见 §2）。

## 1. 三条硬约束

这三条决定了 V2 的实施顺序：并行不能先做画布，必须先动持久化。

### 1.1 `executionState` 是单个 JSON blob，整块读改写

`agent-flow.activities.ts` 各处（`641` / `663` / `1219` 等）都是 `readFlowExecutionState(...)` → 修改 → `toFlowExecutionState(nextState)` 整块覆盖 `StreamTask.executionState`。

两个并发节点同时执行这一序列会互相覆盖：

- `completedNodes` 丢记录 ⇒ **幂等失效，Activity 重试会重新调用模型与工具**
- `budget` 丢计数 ⇒ **`maxModelCalls` / `maxToolCalls` 护栏静默失效，等于无限预算**

这两个护栏都是刚建立的，并行会把它们悄悄拆掉。**不拆表就不能开并行**，这是 V2 的 P0。

### 1.2 `message.delta` 载荷没有节点归属

`packages/types/src/protocol/payloads.ts`：

```ts
export interface MessageDeltaPayload {
  delta: string;
}
```

两个 agent 节点并行吐 token，会交错进同一条助手消息与同一个 `task.fullContent`。这不是渲染问题，是**数据被写坏**。

（`flow.node.started/completed/failed` 载荷已带 `nodeKey` 与 `traceKey`，节点级事件不需要改。）

### 1.3 执行器是单游标

`apps/api/src/temporal/workflows/agent-flow.workflow.ts`：

```ts
let nodeKey: string | undefined = snapshot.entryNodeKey;
while (nodeKey) {
  const result = await activities.executeNode(...);
  nodeKey = selectNextNodeKey(node, result);   // 返回单个 key
}
```

配套的 `AgentFlowNodeOutcome` 是 `'default' | 'approved'` 闭集，快照 `next` 是 `Partial<Record<AgentFlowNodeOutcome, string>>`。前沿化是驱动层重写，不是新增节点类型。

## 2. 变量模型

画布的真正内容不是画框，是**变量引用**。V1 的 `FlowNode` 只有 `config`，没有任何 inputs / outputs 声明，状态隐式流过 message 与 plan。没有变量模型，画布只是装饰：线能连，数据不流。

### 2.1 节点输出由代码声明，不给用户配

| 节点 | 输出 |
| --- | --- |
| `agent` | `text: string`、`toolCalls: array` |
| `plan` | `steps: array`、`stepCount: number` |
| `plan-loop` | `text: string`、`observations: array` |
| `approval` | `approved: boolean`、`comment: string` |
| `synthesize` | `text: string` |
| `condition` | 无输出，只产分支 |
| `join` | 透传被聚合节点的输出 |

外加 Flow 级根变量：`$input.text`（用户消息）、`$input.attachments`。

输出 schema 是闭集常量，与节点类型一一对应；用户不能声明新输出。这样编辑器的变量选择器和 validator 的类型检查用的是同一份事实。

### 2.2 引用只用结构化 `$ref`

```json
{ "prompt": { "$ref": ["planner", "steps"] } }
```

编辑器允许在文本框里写 `{{planner.steps}}`，但**保存时解析成 `$ref` 落库**。

理由：validator 必须能静态检查「被引节点存在 / 在上游 / 类型匹配」。纯字符串模板做不到可靠静态检查——那正是 Dify 会在运行时给出 `undefined` 的地方。契约里只存结构化形式，模板语法只是编辑器的输入便利。

### 2.3 值类型闭集

`string | number | boolean | object | array`。不做泛型、不做嵌套类型参数。够用，且能静态校验。

### 2.4 新校验规则 `ref-dominates`

引用只能指向**在所有到达本节点的执行路径上都必然已完成**的节点（图论上的支配节点 dominator）。这一条同时排除两类错误：

1. 引用下游节点（拓扑序违规）
2. **引用互斥条件分支里的节点** —— 运行时必定拿到空值

第二类是变量模型最容易漏的坑，而它在发布期是可判定的（case 是静态的）。发布期拦下来，比运行时给用户一个 `undefined` 要诚实。

## 3. 条件分支

### 3.1 `condition` 节点（重新设计）

```ts
interface FlowConditionCase {
  readonly key: string;                    // "case_1" ...
  readonly logic: "and" | "or";
  readonly conditions: readonly {
    readonly ref: readonly [string, string];
    readonly operator: FlowConditionOperator;
    readonly value?: string | number | boolean;
  }[];
}
```

`else` 分支隐含存在，不需要声明。

operator 闭集按被引变量的类型分组：

- `string`：`is` / `isNot` / `contains` / `notContains` / `startsWith` / `endsWith` / `empty` / `notEmpty`
- `number`：`eq` / `ne` / `gt` / `lt` / `gte` / `lte`
- `boolean`：`isTrue` / `isFalse`
- `array`：`lengthEq` / `contains` / `empty` / `notEmpty`

**operator 与 `ref` 的类型不匹配 ⇒ 发布期拒绝。** 这正是旧 stub 缺的东西：它连 field 是否存在都不检查。

### 3.2 边语义泛化

- `FlowEdgeWhen` 从单值联合 `"approved"` 改为 `string`
- 合法取值 = 源节点**声明的分支键集合**：`condition` 是 `case_*` + `else`，`approval` 是 `approved` + `rejected`
- `AgentFlowNodeOutcome` 同步从闭集联合改为 `string`；快照 `next: Record<string, string>` 的完备性由 validator 保证（每个声明分支都必须有出边，或都没有——不允许部分覆盖）

顺带把 approval 的 `rejected` 补成真分支。V1 里"拒绝"不是一条边而是任务终止，这在画布上无法表达。

## 4. 并行

### 4.1 fan-out 隐式，fan-in 必须显式

- **fan-out**：放开 `validateDuplicateBranches` 对 default 边的唯一性约束，一个节点可以有多条 default 出边，全部并发启动。
- **fan-in**：不做隐式 join。

不做隐式 join 的理由：条件分支 + 隐式 join = 等一个永远不会到达的分支 = 死锁。做成显式节点后，这件事在发布期可判定：

```ts
interface FlowJoinNodeConfig {
  readonly waitFor: readonly string[];
  readonly policy: "all" | "any";
}
```

新校验规则：`policy: "all"` 且 `waitFor` 中存在两个节点处于**互斥 case 分支**下 ⇒ 拒绝发布。这条规则能算，因为 case 划分是静态的。

### 4.2 前沿执行器

```ts
let frontier: string[] = [snapshot.entryNodeKey];
while (frontier.length > 0) {
  const results = await Promise.all(frontier.map((key) => executeNode(key)));
  frontier = nextFrontier(results);   // 含 join gate 判定
}
```

Temporal 下 `Promise.all` 并发调度 Activity 是确定性的（History 记录每个 Activity 的调度顺序），这条可行。`nodeExecutionId` 已按 `(workflow, nodeKey)` 生成，天然支持并行幂等。

### 4.3 拆表（P0，对应 §1.1）

| 现在 | 改成 |
| --- | --- |
| `executionState.completedNodes` / `stoppedNodes` | 新表 `AgentFlowNodeExecution`，唯一键 `(taskId, nodeExecutionId)` —— 用数据库唯一约束保证幂等，而不是靠读写时序 |
| `executionState.budget` | `AgentFlowRun` 上的整数列，用 Prisma 原子 `{ increment: 1 }`，不再 read-modify-write |
| `executionState.plan` / `planLoop` | 迁入 `AgentFlowNodeExecution.state`（本就是单节点内的状态，放全局是历史包袱） |
| `executionState` 余下部分 | 只留 Flow 级少量标量 |

### 4.4 预算判定移到 Workflow 侧

并行分支各自计数后，"谁先撞线"变成竞态。做法：

1. Activity 内原子 increment，并在结果里**返回当前用量**
2. Workflow 看到超额就**不再扩展 frontier**；已在飞的 Activity 允许跑完

语义上是"软刹车"。比让多个 Activity 互相抢判定要确定得多，也不需要分布式锁。

### 4.5 消息分片（对应 §1.2）

`MessageDeltaPayload` 增加 `nodeKey?: string`。并行的 agent 节点各写自己的分片，前端按 `nodeKey` 分组渲染；`task.fullContent` 不再由多个节点直接追加，改由 `synthesize` / `join` 节点产出最终文本。

**这一条不做，并行跑出来的回答就是交错的乱码。**

### 4.6 明确不做：图上的环

不引入 `loop` / `iteration` 节点。`plan-loop` 把循环关在节点内部是正确的取舍——图上的环会让前沿算法需要处理收敛判定与迭代上下文，代价陡增。Dify 的 iteration 节点同样是节点内循环。

## 5. 迁移

`schemaVersion: 1 → 2`，**不做双运行时**。

理由：按根 `AGENTS.md`「不写长期兼容旧接口的代码」，而版本化工件的兼容成本会同时渗进 validator、compiler 和 workflow 三处。

- 4 个内置模板（`flow-definition.templates.ts`）是代码，直接改写为 V2 形态
- 数据库中的 `AgentFlowVersion` 记录：确认为空，无需迁移历史工件

## 6. 落地顺序

**第一批 —— schema 无关，画布来了不用重做**

1. admin：Flow 列表 + 版本历史 + 发布 / 回滚 / 导出 / 导入
2. admin：Agent 表单绑定 `defaultFlowVersionId` ← Flow 的唯一触发入口
3. admin：FlowDefinition JSON 编辑器 + 校验（错误按返回的 `path` 定位）

做完这批，现有直链 Flow 在 admin 测试会话中真正可跑。

**第二批 —— V2 地基，无 UI**

4. 拆表 + 原子预算（P0，不做则并行必然破坏护栏）
5. `message.delta` 增加 `nodeKey` 与分片渲染
6. 变量模型 + `$ref` 静态校验（含 `ref-dominates`）
7. `condition` / `join` 节点 + 分支键泛化
8. 前沿执行器重写

**第三批**

9. React Flow 画布 —— 此时 `FlowDefinition.layout` 字段（已排除在 digest 之外）才开始有用

## 7. 待决

- `join` 的 `policy: "any"` 语义下，未完成分支是否需要取消？取消会影响预算计数与事件序，倾向"不取消、让其跑完但结果不进入下游"。
- 变量引用能否跨 `join`？若 `join` 只透传，则下游引用的是 join 前的节点，`ref-dominates` 需要把 join 视作汇聚点特殊处理。
- Flow 的删除 / 归档语义。当前 `AgentFlowVersion.flow` 是 `onDelete: Restrict`，`StreamTask.flowVersionId` 也是 `Restrict`，即"跑过任务的 Flow 不可删"由数据库强制。这是合理意图，但缺少面向管理端的"停用 / 归档 Flow"原语。
