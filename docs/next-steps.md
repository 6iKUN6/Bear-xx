# 下一步计划

> 更新于 2026-08-07。承接「群聊多智能体」这一轮改造之后的待办。
> 相关文档：[hitl.md](../apps/api/docs/hitl.md)、[agent-loop-evolution.md](../apps/api/docs/agent-loop-evolution.md)、[agent-chat-chain.md](../apps/api/docs/agent-chat-chain.md)

## 已确立的约束（动手前先读）

这些是排查过程中确认的事实，会直接否掉一部分方案：

- **群聊路由跑在流建立之前**。`resolveAnsweringAgent()` 在 `createChatTask()` 之前执行，此时 StreamTask 不存在、SSE 未开始。所以「正在指派」的过程**无法**用流内事件表达，只能由前端本地态呈现。
- **`task.created` 是合成事件**（`prependEvent`，id 恒为 `'0'`），不入持久化流，刷新即失。需要回溯的信息必须另发真事件（现由 `agent.routed` 承担）。
- **气泡是前端乐观创建的**，早于任何服务端事件；`agent.loop.start` 到达时气泡已在屏幕上。
- **HITL 只在 ReAct 策略生效**。只有 `common-react.graph.ts` 透传 `approvalToolNames`；plan-execute / hybrid 是手写 JS 编排，跑在 LangGraph 图外，checkpointer 覆盖不到。

## P0 · 协议债

### 1. 事件载荷强类型化

21 个事件中只有 4 个有契约（`TaskError` / `ConversationTitleUpdated` / `ApprovalRequired` / `AgentRouted`），其余 17 个 payload 是 `Record<string, unknown>`，前端靠 `readString(payload.summary)` 猜字段——**改后端字段名前端不报错，只会静默失效**。

**消费方有三个，不是两个**（这决定了收益规模）：

| 消费方 | 现状 |
|---|---|
| `apps/mobile/src/utils/streamFeedback.ts` | `readString(payload.publicStatus / summary / mode / skill / step ...)` |
| `apps/api/.../conversation-trace.mapper.ts` | `readString(payload,'title') ?? readString(payload,'step') ?? ...` 多字段兜底链（`:95-100`、`:117-122`） |
| `apps/mobile/src/store/chatStore.ts` | 从 envelope 取 `agentId` / `status` 等 |

mapper 里的 `??` 兜底链正是根 AGENTS.md 禁止的形态。补齐契约后这些链会自然坍缩成单字段直读——这是本项收益里最实的一块，不只是"类型更好看"。

#### 落地形态：收进 `packages/types/src/protocol`

目标是让**发事件**和**读事件**两侧都由同一份映射表约束，新增事件时漏改任一侧直接编译失败。

目录（现 `protocol/index.ts` 已 248 行，一并拆分）：

```txt
packages/types/src/protocol/
  index.ts          # barrel，保持现有导出路径不变
  events.ts         # StreamTaskEventType + 终态集 + 中文文案（从 index.ts 拆出）
  payloads.ts       # 21 个载荷 interface + StreamTaskPayloadMap
  factory.ts        # createStreamEvent / createStreamPayload
  strategy.ts       # AgentStrategyMode + 中文标签（从 apps/api 迁入）
  approval-card.ts  # 不动
```

核心是一张映射表 + 一个共享基类：

```ts
/** agent 执行类事件共享的展示字段 */
export interface StreamNodePayloadBase {
  /** 节点标识 */
  nodeKey: string;
  /** 同一逻辑单元的生命周期事件共享此 key，前端据此折叠为一张卡 */
  traceKey: string;
  /** 面向用户的中文状态 */
  publicStatus: string;
}

export interface StrategySelectedPayload extends StreamNodePayloadBase {
  mode: AgentStrategyMode;
  confidence: number;
  reason: string;
  skills: string[];
  toolGroups: string[];
  maxSteps: number;
}

/** 事件类型 → 载荷；新增事件必须在此登记，否则 createStreamEvent 不接受 */
export interface StreamTaskPayloadMap {
  [StreamTaskEventType.StrategySelected]: StrategySelectedPayload;
  [StreamTaskEventType.WorkflowStepStart]: WorkflowStepPayload;
  // ... 21 项全登记
}
```

发送侧（后端各 `yield` 点直接替换，形状与现有 `AgentLoopStreamEvent` 一致）：

```ts
export function createStreamEvent<T extends keyof StreamTaskPayloadMap>(
  type: T,
  payload: StreamTaskPayloadMap[T],
): { type: T; payload: StreamTaskPayloadMap[T] } {
  return { type, payload };
}
```

是恒等函数，**零运行时开销**，作用是强制调用点写出事件类型，类型与载荷对不上即编译报错。`createStreamPayload(type, payload)` 同理，留给只需要载荷不需要信封的场景（如 trace mapper 的测试夹具）。

#### 两个需要先定的决策

1. **要不要运行时校验（zod）？倾向不要。**
   后端已用 zod，但这个包会被小程序打包，zod 约 50KB。且历史 payload 漂移已被 `conversation-trace.mapper` 挡在写入侧（前端读 trace 走的是结构化列，不是原始 payload），实时 SSE 流的生产者永远是当前版本后端。按 AGENTS.md「契约保证存在 → 直接读取」，纯编译期约束即可。若确需运行时校验，zod schema 只放 API 侧。

2. **`AgentStrategyMode` 要上移。**
   它现在在 `apps/api/.../agent-loop.types.ts:5`，但已经以裸字符串泄漏到前端（`streamFeedback.ts:162` 的 `策略 ${readString(payload.mode)}`）。载荷类型引用它就必须迁进 protocol，顺带把四种策略的中文标签也收进来，消灭前端的 stringly-typed 展示。

#### 分期（避免大爆炸）

| 期 | 内容 | 风险 |
|---|---|---|
| 1 | 按**当前真实发送形状**写全 21 个 interface + map，不改任何行为 | 无，纯描述现状 |
| 2 | 后端各 `yield` 点换成 `createStreamEvent`；编译错误即暴露契约漂移 | 低，错误在编译期 |
| 3 | 前端 `readString(payload.x)` 换成按 map 收窄；trace mapper 的 `??` 链坍缩 | 中，要逐事件核对 |
| 4 | 把实际恒存在的字段从 `?:` 收紧为必填 | 中，需回归验证 |

⚠️ 小程序是独立发版的，**字段重命名不能一步到位**：走「加新字段 → 前端发版 → 下版删旧字段」，否则旧客户端读空。这是发布节奏约束，不属于 AGENTS.md 禁止的长期兼容层。

### 2. 审批链路事件补全

- 只有 `ApprovalRequired`，用户 approve/reject/edit 之后**没有事件** → trace 里永远停在「待人工确认」，看不到结果。需新增 `ApprovalResolved`（决定 + 决定人 + 改后参数）。
- `ApprovalRequired` 目前**不入 trace**，刷新后看不到「这条消息曾经过审批」。

> 任务生命周期事件（`TaskCreated/Started/Completed/Canceled/Expired`）同样不进 trace，但**建议维持现状**——`StreamTask` 表已有完整记录，再进 trace 属重复存储。`MessageDelta` 不进 trace 是刻意的（量太大）。

## P1 · 多智能体协同

目标形态：一次提问由多个成员分工完成（「画师出图 + 文案配文」），进一步可按拓扑分发并由某个角色校验到收敛。

### 现状约束（决定性事实）

| 事实 | 位置 |
|---|---|
| 全仓**没有任何原生 `StateGraph`**（`addNode`/`addEdge`/`Send` 零命中） | — |
| 只有 ReAct 真跑在图上：`createAgent()` 返回编译好的图 + checkpointer | `common-chat-agent.factory.ts:44` |
| plan-execute / hybrid 是 **27 行空壳**，都转发给同一个手写生成器 | `graphs/plan-execute.graph.ts:24` |
| 两者共用同一段代码，**只差一个 boolean** `isDynamic` | `agent-loop-controller.service.ts:47` |
| group-router 返回**单个** `agentId`，跑在建流之前，且在 `conversation` 模块，与 agent-loop 无连接 | `group-router.service.ts:68`、`stream-task.service.ts:179` |
| 1 StreamTask ↔ 1 assistant Message ↔ 1 `agentId` ↔ 1 SSE 流 ↔ 1 个 `fullContent` 列 | `schema.prisma:216,221` |
| trace 已有 `parentId` + `depth` 自关联——**层级已支持** | `schema.prisma:295,298` |
| checkpointer 已是 Postgres 单例，`thread_id = taskId` | `agent-checkpointer.service.ts` |

最后两条是净资产：trace 树形结构和持久化 checkpoint 都已就位。

### 拆成三层看，成本差一个量级

**L1 · 并行多答**：N 个 agent 各自独立回答，互不依赖。
路由 schema `{agentId}` → `{answers:[{agentId, task}]}`（structured output 已接，这块便宜）+ 消息模型「一问一答」→「一问多答」+ 前端多气泡。**不需要新编排层，中等改动**，主要在数据模型和前端。

**L2 · 拓扑分发（DAG / dependsOn）**：需要一个跨 agent 的编排器，持有 DAG 状态、拓扑排序、把前驱产出注入后继上下文。
⚠️ `AgentLoopController` **形状像但不能直接复用**：它的执行单元是 step，全程共享同一个 `input.messages`、同一个 `llm`、同一套 tools（`agent-loop-controller.service.ts:124-130`）；跨 agent 编排的每个节点要换 systemPrompt、工具集、模型预设和身份。这是新的一层，不是改造。**大改动**。

**L3 · 校验闭环**：循环 + 终止条件 + 全局预算 + 失败重试。三个真实风险：

- **无界循环烧钱**。`maxSteps` 是单 agent 内预算（默认 6），跨 agent 没有全局预算概念，校验不过就重跑没有闸门。
- **必须可中断恢复**。这一层动辄跑几分钟且中途可能撞 HITL；controller 是纯生成器，进程重启或客户端断连＝全丢。
- **router 干不了校验**。`GroupRouterService` 是 `temperature:0` + `maxOutputTokens:100` 的分类器（`group-router.service.ts:8-9`），只输出一个 id。校验要通读全部产出，是另一个角色（critic/supervisor），复用它会把 300ms 的轻量前置路由变成重调用，拖慢每条群聊消息。

L3 的第二点直接指向下一节的策略图迁移。

### 关键设计决策：N 个流还是 1 个流

L1 就必须定，定错了 L2/L3 全部返工。**倾向：编排器一个父 StreamTask，每个 agent 一个子 StreamTask。**

- 复用现有全部机制——resume、trace、cancel、`fullContent`、HITL 全是 task 粒度
- trace 的 `parentId` 天然对应父子任务
- **HITL 冲突自然化解**：`WAITING_HUMAN` 落在子任务上，父任务等它；单流方案里两个 agent 同时要审批，task 级状态机直接打架
- 代价：schema 加 `parentTaskId`；前端并发订阅多流

⚠️ 小程序 SSE 走 `wx.request` + `enableChunked`（`api/request.ts:226`），微信并发请求上限 10，长任务会长时间占槽。3–4 个 agent 可行，再多需做流复用。

不推荐单流 + 事件打 `agentId` 标签：省连接数，但 `fullContent` 单列要拆、HITL 状态冲突无解、消息模型照样要改，不划算。

### 策略图迁移（原 P5b，提级为 L2/L3 的前置）

**结论：迁 `plan_execute` + `hybrid`；`direct` 和 `react` 不动。**

- **ReAct 不动**：`createAgent()` 返回的已经是编译好的 StateGraph，HITL 中间件走官方维护路径，手写重画会失去 `interruptOn` / middleware 的上游维护。
- **direct 不动**：单次模型调用（59 行），套图纯增间接层，零收益。

plan/hybrid 该迁的理由，按含金量排序：

1. **HITL 覆盖是功能缺口，不是优雅问题。** checkpointer 只能托管图状态，controller 跑在图外 → plan/hybrid 永远无法审批。而麦当劳 MCP 下单本质多步（查询→选择→下单），最可能被路由到 plan/hybrid，恰是最需要审批的场景。**它实际是 P2 MCP 的硬前置。**
2. **断点恢复。** P3 记的「生图超时 + SSE 重连未走 resume」，图内节点粒度恢复能治本。
3. **循环与扇出原语。** L3 的校验闭环就是 `addConditionalEdges(verify, shouldContinue, {continue: dispatch, done: END})`；L2 的并行分发就是 `Send`。手写这两个等于自己实现一遍状态持久化。
4. plan/hybrid 现在共用代码 + 一个 boolean，需求一发散就会长成分支树。

**成本不在图结构**（5 个节点：plan → execute → evaluate → synthesize + 条件边，比现在的循环还清楚），**在事件流桥接**：现有事件是手写 `yield`，语义精确（中文 `publicStatus`、`traceKey`、`nodeKey` 都是刻意设计）。迁图后要从 `streamMode: ['messages','updates']` 双流还原出等价事件序列，且根 AGENTS.md 明令禁用 `streamEvents({version:'v3'})`。

可原样搬运：`buildStepPrompt` / `buildSynthesisPrompt` / `trace-summary.builder`。

⚠️ 迁移会重排事件发射点，而 17/21 事件无契约 → 字段错位不报错只静默失效。**P0-1 是这次迁移的安全网，不是可选项。**

### 务实建议

别直接冲 L3。一次群聊提问触发 N 个 agent + 校验重跑，token 成本是单聊的 5–10 倍，延迟进分钟级。先把 L1 做出来跑一段，看真实场景里"需要依赖编排"的比例——很可能并行多答就覆盖了大部分，L2/L3 是长尾。

## P2 · 能力扩展

### 麦当劳 MCP 接入

脚手架约 60% 已在位：`apps/api/src/modules/ai/mcp/McDonalds.mcp.ts`（完整 client 封装 + 工具目录注释）、`@langchain/mcp-adapters` 依赖、`MCDONALDS_MCP_TOKEN` 环境变量、trace 的 `mcpServer`/`mcpTool` 字段。

缺的桥接：

- `loadMcDonaldsMcpTools()` 是 async，而 `CapabilityRegistry` 在构造函数里同步注册 → 需改 async provider 或懒加载。
- 新增 `mcd-order` 工具组；**只给 `create-order` 挂 `requiresApproval`**，查询类工具免审批。
- `create-order` 返回 `payH5Url` 支付页，小程序侧的落地方式待定。

⚠️ **前置**：HITL 必须先经真实验证（会花真钱、下真实订单）。

### HITL 扩到 Plan/Hybrid（P5b）

→ **已提级到 P1「策略图迁移」**。它是麦当劳 MCP 的硬前置（下单本质多步，最可能走 plan/hybrid，而这两个策略当前无法审批），不是 P2 的可选项。

### 结构化审批卡

`packages/types/src/protocol/approval-card.ts` 的 `ApprovalCardData` 与 `hitl/approval-card.builder.ts` **设计完成但从未接线**——`payload.card` 从没发出过，移动端渲染的是原始 payload（工具名 + JSON 参数）。接上后可展示风险等级、结构化字段、预估费用；`enhanceWithAi()` 目前是 TODO。

## P3 · 技术债

- **生图工具调用超时**：此前设了 3 分钟，但根因（工具超时后 SSE 重连未走 resume）未定位。
- **`jsx-quotes` lint 报错**：`ChatWorkspace`、`pages/agents` 等文件的 JSX 属性引号不符合规则，属既有状态。清理会产生大量无关 diff，建议单独做一次格式提交。
- **群聊路由上下文窗口**：目前取尾部 4 条消息、每条截 120 字（`GROUP_ROUTE_CONTEXT_MESSAGES`）。若延续判断不够准可调大，但要权衡：路由是每条群聊消息的前置调用，得控制成本与延迟。
- **`conversation-trace` 的 MCP 字段**：`mcpServer`/`mcpTool` 已定义但无人写入，接 MCP 时一并补。

## 建议顺序

```
P0-1（载荷强类型 · 安全网）
   │
   ├──► 策略图迁移（plan/hybrid → StateGraph）
   │       │
   │       ├──► HITL 覆盖 plan/hybrid ──┐
   │       │                            ├──► P2 麦当劳 MCP
   │       │        P0-2（审批事件）────┤
   │       │        HITL 真实验证 ──────┘
   │       │
   │       └──► L2 拓扑编排（父子 task）──► L3 校验闭环
   │
   └──► L1 并行多答（只卡消息模型，可与迁移并行推进）
```

两条独立线：**L1 只依赖消息模型改造，不依赖图迁移**，可同时开工。L2/L3 必须等图迁完。

理由：载荷强类型化是图迁移的安全网（迁移会重排事件发射点，无契约则静默失效）；图迁移带来的 HITL 覆盖 + 审批事件补全，共同构成 MCP 下单的前提。
