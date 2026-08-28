# AgentFlow V2 数据模型设计（变量 / 分支 / 并行）

> 状态：**部分已落代码**。§4.3 拆表、§2 变量模型、§3 条件分支与边语义泛化已实现（`schemaVersion: 2`）；
> 并行相关的 §4.1 fan-out / join、§4.2 前沿执行器、§4.5 消息分片仍是设计。各节标注了状态。
> 日期：2026-08-20（落地状态于 2026-08-21 更新）。
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

### 1.2 并行吐字会写坏同一段正文

`task.fullContent` 与助手消息本质是**一段线性文本**：

```ts
export interface MessageDeltaPayload {
  delta: string;
}
```

两个 agent 节点并行吐 token，会交错进同一条助手消息与同一个 `task.fullContent`，且各写一次 `fullContent` 后互相覆盖。这不是渲染问题，是**数据被写坏**。

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

### 2.1 节点输出由代码声明，不给用户配 —— **已落地**

唯一事实源是 `packages/types` 的 `FLOW_NODE_OUTPUTS`；运行时随节点完成写入
`AgentFlowNodeExecution.outputs`（与幂等记录同一行、同一事务），下游经 `$ref` 读取。

| 节点 | 输出 |
| --- | --- |
| `agent` | `text: string` |
| `plan` | `steps: array`、`stepCount: number` |
| `plan-loop` | `text: string`、`observations: array` |
| `approval` | `approved: boolean`、`comment: string` |
| `synthesize` | `text: string` |
| `condition` | 无输出，只产分支 |
| `join` | 透传被聚合节点的输出（并行批次） |

外加 Flow 级根变量 `$input.text`（用户本轮消息正文）。

两处相对初稿的收缩，都是为了不留「永远算不对」的字段：

- **`agent.toolCalls` 不做**。唯一的运行时来源是流事件，而 `tool.call.start` 的工具名可能缺失
  （`tools.nameById` 在首个 chunk 尚未有值），据此建数组会漏报已调用的工具——引用它的
  `notContains` 会直接给出相反的答案。要这个输出，得先让底层流为每次调用给出稳定名称。
- **`$input.attachments` 不做**。任务载荷 `ChatTaskPayload` 里没有这个字段，声明出来就是一个
  恒为空的输出，引用它的条件永远判 false。

输出 schema 是闭集常量，与节点类型一一对应；用户不能声明新输出。这样编辑器的变量选择器和 validator 的类型检查用的是同一份事实。

### 2.2 引用只用结构化 `$ref`

```json
{ "prompt": { "$ref": ["planner", "steps"] } }
```

编辑器允许在文本框里写 `{{planner.steps}}`，但**保存时解析成 `$ref` 落库**。

理由：validator 必须能静态检查「被引节点存在 / 在上游 / 类型匹配」。纯字符串模板做不到可靠静态检查——那正是 Dify 会在运行时给出 `undefined` 的地方。契约里只存结构化形式，模板语法只是编辑器的输入便利。

### 2.3 值类型闭集

`string | number | boolean | array`。不做泛型、不做嵌套类型参数。够用，且能静态校验。
初稿含 `object`，落地时去掉：没有节点声明对象输出，也没有算子接受对象，留着就是一个既不产生
也不消费的死类型。真有节点输出对象时再加是一行的事。

### 2.4 新校验规则 `ref-dominates` —— **已落地**

引用只能指向**在所有到达本节点的执行路径上都必然已完成**的节点（图论上的支配节点 dominator）。这一条同时排除两类错误：

1. 引用下游节点（拓扑序违规）
2. **引用互斥条件分支里的节点** —— 运行时必定拿到空值

第二类是变量模型最容易漏的坑，而它在发布期是可判定的（case 是静态的）。发布期拦下来，比运行时给用户一个 `undefined` 要诚实。

## 3. 条件分支

### 3.1 `condition` 节点（重新设计）—— **已落地**

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

落地时补了一维初稿没写的约束：`requiresValue`。`empty` 这类算子不带比较值，而 `is` 缺了值就会去和
`undefined` 比较——静默判 false，仍是「永远算不对」。因此「该带值却没带」和「不该带却带了」都在
发布期拒绝。运行时另有一层：被引值的实际类型不符时该条判定为假，而**上游输出整个读不到时显式失败**
（`ref-dominates` 已保证被引节点必定先完成，读不到就是我们自己写漏了，静默走 else 等于重犯旧 stub 的错）。

### 3.2 边语义泛化 —— **已落地**

- `FlowEdgeWhen` 从单值联合 `"approved"` 改为 `string`
- 合法取值 = 源节点**声明的分支键集合**，由共享契约的 `flowNodeBranchKeys` 给出：`condition`
  是 `case_*` + `else`，`approval` 是 `approved`。validator、运行时回放与画布共用这一份事实
- `AgentFlowNodeOutcome` 同步从闭集联合改为 `string`；完备性由 `branch-coverage` 规则保证
  （每个声明分支都必须有出边，或都没有——不允许部分覆盖）

**`approval` 的 `rejected` 暂不补成真分支**。初稿想顺手做掉，但当前没有任何节点类型能作为它的
落点——需要一个"以固定文案终止"的终端节点，而运行时已经把 `reject_terminate` 正确处理成业务
终态。现在声明 `rejected` 只会多出一个无处可去的分支键，属于死字段。要做，先加终端节点类型。

### 3.3 为什么 condition 不需要等前沿执行器

`agent-flow.workflow.ts` 选下一跳是 `node.next[result.outcome]` —— 单游标按分支键选**一条**边。
condition 的多条出边互斥，只走一条，现有执行器直接就能跑。需要重写执行器的只有 fan-out
（多条 default 边同时走）与 join。因此第二批被切成两段：变量模型 + condition 先落地并可验证，
并行相关的 join / fan-out / `message.delta` 分片 / 前沿执行器留在下一段。

## 4. 并行

### 4.1 fan-out 隐式，fan-in 必须显式 —— **已落地**

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

### 4.2 前沿执行器 —— **已落地**

初稿草图是 `Promise.all` 逐轮收口，实做时发现它是错的：

```ts
// ✗ 这是个屏障：本轮所有节点都结束才推进下一轮
while (frontier.length > 0) {
  const results = await Promise.all(frontier.map((key) => executeNode(key)));
  frontier = nextFrontier(results);
}
```

屏障会让 `join(any)` **退化成 `all`**——配置写着"任一完成即继续"，实际却等齐了全部。是 `join(any)` 的用例超时暴露的。

实际做法是「持续在飞」：用 `Promise.race` 取最先落地的那个节点，立刻结算它的后继，其余节点保持在飞。

```ts
const inFlight = new Map<string, Promise<...>>();
launch(snapshot.entryNodeKey);
while (inFlight.size > 0) {
  const settled = await Promise.race([...inFlight.keys()].sort().map(k => inFlight.get(k)!));
  inFlight.delete(settled.key);
  completed.add(settled.key);
  for (const target of selectNextNodeKeys(settled.node, settled.result).sort()) {
    if (scheduled.has(target)) continue;          // 扇入去重
    if (!isJoinSatisfied(getSnapshotNode(target), completed)) continue;   // join gate
    launch(target);
  }
}
```

确定性要点：

- 调度顺序对 History 稳定 —— 遍历 `inFlight` 与后继候选前都排序
- 取消 / 超时在并行分支里**不能用 `return`**（那只结束一个分支），改抛 `RunHaltedError` 哨兵
- 一条分支停止时**不掀桌**：其余分支的副作用已经发生，等它们各自落地后再收敛终态
- 入口节点也要先过 `assertRunnable()` —— 取消信号可能在 `loadRunSnapshot` 的 await 期间就到了（这条是回归用例抓到的）

`nodeExecutionId` 已按 `(workflow, nodeKey)` 生成，天然支持并行幂等。

### 4.3 拆表（P0，对应 §1.1）——**已落地**

| 原状态 | 现在 |
| --- | --- |
| `executionState.completedNodes` / `stoppedNodes` | 新表 `AgentFlowNodeExecution`，唯一键 `(taskId, nodeExecutionId)` —— 用数据库唯一约束保证幂等，而不是靠读写时序 |
| `executionState.budget` | `StreamTask.flowModelCalls` / `flowToolCalls`，Prisma 原子 `increment`，不再 read-modify-write |
| `executionState.started` | `StreamTask.flowRunStartedAt`，以 `IS NULL` 条件更新原子声明发事件的归属 |
| `executionState.pendingApproval` | 删除。`AgentFlowApproval` 的 PENDING 记录本就是唯一事实源，快照只能容纳一个等待节点，并行下必然失真 |
| `executionState.plan` / `planLoop` | **留在原处**。设计初稿称其为"单节点内的状态"，与代码不符：`plan` 由 plan 节点写，approval / plan-loop / synthesize 三个节点读，是跨节点数据。它由 §2 的变量模型接管，不是搬进 `AgentFlowNodeExecution` |

落地后 `executionState.agentFlow` 只剩 `plan` / `planLoop`，仍是整块读改写。**因此 §4.3 完成不等于并行安全**，扇出前还欠 §2（变量模型接管 plan）、§4.5（正文单一生产者）与 §4.2（前沿执行器）——三项现均已落地，`executionState` 已整块移除。

顺带修掉一个此前不在计划内的幂等漏洞：`resumeNode` 原先没有回放短路，节点事务已提交而结果上报丢失时，Temporal 会带着同一份审批决定把节点整个重跑——模型重复调用，已放行的工具重复执行。

仍未解决：`AgentFlowApproval` 缺 `(taskId, nodeKey, kind) where status = PENDING` 的**部分**唯一索引，并发创建审批会落出两条 PENDING 卡片。Prisma schema 无法声明部分索引，只能手写进 `migration.sql`，而本仓库禁止手写迁移 SQL，故留待人工决策。降级成完整唯一索引是错的——那会挡掉同一节点在前一轮已决议后的第二轮审批（`reject_replan` 的 revision 2）。

### 4.4 预算判定移到 Workflow 侧 —— **已落地**

并行分支各自计数后，"谁先撞线"变成竞态。做法：

1. Activity 内原子 increment，并在结果里**返回当前用量**
2. Workflow 看到超额就**不再扩展 frontier**；已在飞的 Activity 允许跑完

语义上是"软刹车"。比让多个 Activity 互相抢判定要确定得多，也不需要分布式锁。

### 4.5 单一正文生产者（对应 §1.2）—— **已落地**

初稿方案是给 `MessageDeltaPayload` 加 `nodeKey?: string`、前端按节点分组渲染。实做时发现它答不上一个问题：**刷新之后这条消息的正文是什么？** 分组渲染只能让前端把两段分开显示，落库的仍是两段交错的文本。约束在图上，不在协议上。

实际做法：**只有图的终节点（没有出边）产出这条助手消息的正文**。中间 agent 节点静默执行——不下发 `message.delta`、不写 `fullContent`，产出进 `outputs.text` 供下游 `$ref` 引用。这正是 `plan-loop` 步骤今天的行为。

- 运行时判定：`agent-flow.activities.ts` 的 `isAnswerNode`，按 Definition 的边算
- 校验期护栏：`concurrent-answer-nodes` 拦住「两个可能并发的终节点」；互斥的多个终节点（condition 各分支各自收尾）放行
- 并行分支里**可以**放 agent 节点——规则只针对终节点

因此**不引入** `MessageDeltaPayload.nodeKey`：加了没有消费者，而一个没人消费的协议字段会让后来者以为分片已经做了。

对四个内置模板零行为变化：它们都只有一个吐字节点，且都是终节点。

### 4.6 图上的环 —— **决定已推翻，改为要做**

初稿写的是「明确不做」，理由是 `plan-loop` 已把循环关在节点内部，图上的环会让前沿算法需要处理收敛判定与迭代上下文、代价陡增。

**这个决定已被推翻**：用户明确要求「手动实现循环的逻辑，还有预设的可用循环节点」——`plan-loop` 只能表达「按计划逐步执行」，表达不了「重试到满足条件」「对一批数据逐个处理」这类循环。

初稿列出的代价仍然真实，只是不构成不做的理由。它们变成了设计必须回答的问题，**设计见 `agent-flow-loops.md`**，任务见 issue #9：

- **终止判定**：靠条件？靠最大轮数？两者都要？
- **迭代上下文**：第 N 轮怎么引用第 N-1 轮的输出？`$ref` 现在按节点 id 取，环里同一个 id 会有多份输出
- **与前沿执行器的冲突**：现在的 `completed` / `scheduled` 两个集合都假设「一个节点最多跑一次」，有环之后语义要重新定义
- **与预算护栏的交互**：`maxModelCalls` / `maxDurationSeconds` 是唯一兜底，死循环必须撞得上它们
- **校验器的 `cycle` 规则**：现在硬拒任何环，要改成「只允许被循环节点圈起来的环」

## 5. 迁移 —— **已落地**

`schemaVersion: 1 → 2`，**不做双运行时**：V1 工件由 Zod 的 `z.literal` 直接拒绝，有用例守住。

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

4. ~~拆表 + 原子预算（P0，不做则并行必然破坏护栏）~~ **已落地，见 §4.3**
5. ~~`message.delta` 增加 `nodeKey` 与分片渲染~~ **已落地，但换了解法，见 §4.5**
6. ~~变量模型 + `$ref` 静态校验（含 `ref-dominates`）~~ **已落地**
7. ~~`condition` + 分支键泛化~~ **已落地**；~~`join`~~ **已落地，见 §4.1**
8. ~~前沿执行器重写~~ **已落地，见 §4.2**

第 6 与第 7 项必须同时落：`$ref` 单独声明出来没有任何消费者，就是死字段；condition 的
`conditions[].ref` 是它的第一个真实消费者。

**第三批**

9. React Flow 画布 —— 此时 `FlowDefinition.layout` 字段（已排除在 digest 之外）才开始有用

## 7. 待决

- ~~`join` 的 `policy: "any"` 语义下，未完成分支是否需要取消？~~ **已定：不取消**。前沿执行器里慢分支留在 `inFlight` 中跑完，其输出正常落库；`scheduled` 去重保证它落地时不会把 join 再触发一次。取消会牵动预算计数与事件序，收益不抵复杂度。
- ~~变量引用能否跨 `join`？~~ **已定：`policy: "all"` 可以，`"any"` 不行**。`flowMustCompleteBefore` 把 join 特殊处理：`all` 对 `waitFor` 求**并集**（都跑完了，都有保证），`any` 求交集（只保证公共前置）。这不是教科书支配集——支配集假设"多条出边只走一条"，那对 condition 成立、对并行扇出不成立。策略读不出来时缺省到 `any`，只少给保证、不虚报。
- Flow 的删除 / 归档语义。当前 `AgentFlowVersion.flow` 是 `onDelete: Restrict`，`StreamTask.flowVersionId` 也是 `Restrict`，即"跑过任务的 Flow 不可删"由数据库强制。这是合理意图，但缺少面向管理端的"停用 / 归档 Flow"原语。
