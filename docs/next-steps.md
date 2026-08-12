# 下一步计划

> 更新于 2026-08-12。承接「群聊多智能体」+「策略图迁移 / HITL」几轮改造之后的待办。
> 相关文档：[plan-graph-migration.md](../apps/api/docs/plan-graph-migration.md)、[hitl.md](../apps/api/docs/hitl.md)、[agent-loop-evolution.md](../apps/api/docs/agent-loop-evolution.md)、[agent-chat-chain.md](../apps/api/docs/agent-chat-chain.md)

## 进度总览（新会话先读这里）

### ✅ 已完成并验证

| 项                                    | 落点                                                                | 备注                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| P0-1 事件载荷强类型化                 | `packages/types/src/protocol/{events,payloads,factory,strategy}.ts` | 21 事件全有契约 + `StreamTaskPayloadMap`，收发两侧编译期约束                                      |
| 策略图迁移 plan/hybrid → `StateGraph` | `agent-loop/execution/plan-graph.runner.ts`                         | 手写 `AgentLoopController` 已删；事件序列与迁移前逐项一致                                         |
| HITL 覆盖 plan/hybrid（工具审批）     | `plan-graph.runner.ts` + `agents/common-chat-agent/agent-hitl.ts`   | 子图内中断穿透外层 checkpointer；多轮 `WAITING_HUMAN` 走通                                        |
| 计划审批 HITL（plan_execute 默认开）  | 见 [hitl.md](../apps/api/docs/hitl.md) P5c                          | 出计划后暂停：通过 / 编辑步骤（改文字+追加）/ 带意见打回重规划 / 终止                             |
| 分步工具隔离                          | `agent-loop/execution/step-tool-scope.ts`（`StepContext` 中间件）   | 修「generateImage 每步都调」；审批工具只在计划安排它的步骤可见                                    |
| 端到端验证                            | —                                                                   | 小程序真机跑通（用户 2026-08-12 确认）：计划审批四决定 + 生图只弹一次                             |
| P2-1 麦当劳 MCP 工具接入              | `ai/mcp/mcp-client-manager.service.ts` + `CapabilityRegistry`       | 8 个审核工具注册到 `mcd-order`；`create-order` 唯一需审批；trace 记录 MCP 来源；未做订单入库/支付 |

> 关键实测结论沉淀在 [plan-graph-migration.md](../apps/api/docs/plan-graph-migration.md)：`custom` streamMode + `config.writer`（顶层 `writer()` 静默失效）、多模式块是 3 元组、resume 不重放、**子图收不到 messages 注入的步骤提示词 → 只能走 state 通道**（这条踩了很久，务必记住）。

### ⏳ 下一步候选（按建议顺序，详见下方各节）

| 优先 | 项                                                        | 依赖                          | 规模                    |
| ---- | --------------------------------------------------------- | ----------------------------- | ----------------------- |
| A    | **P2-2 点餐订单入库与回显**                               | P2-1 已完成；需定订单数据模型 | 中                      |
| A'   | 结构化审批卡（`ApprovalCardData` 接线）                   | 无                            | 中，与 MCP 配合体验更好 |
| B    | **L1 并行多答**（一问多答）                               | 只卡消息模型，可与 A 并行     | 中                      |
| C    | P0-2 剩余：审批/计划审批入 trace 的回归 + `enhanceWithAi` | 无                            | 小                      |
| D    | L2 拓扑编排 → L3 校验闭环                                 | 图迁移已完成（前置已就绪）    | 大                      |

### 📌 收尾小项（随手可做）

- `apps/api/docs/agent-loop-evolution.md` 补一节「plan/hybrid 已迁 StateGraph + 计划审批」（目前只在 plan-graph-migration.md / hitl.md 有记载）。
- 分步工具隔离依赖 planner 标注 `suggestedTools`；已强化 `task-planner.md`，但若模型仍漏标某审批工具，该工具会退回不隔离（软兜底，非硬保证）。真机多跑几个多步生图/下单任务观察标注可靠性。

## 已确立的约束（动手前先读）

这些是排查过程中确认的事实，会直接否掉一部分方案：

- **群聊路由跑在流建立之前**。`resolveAnsweringAgent()` 在 `createChatTask()` 之前执行，此时 StreamTask 不存在、SSE 未开始。所以「正在指派」的过程**无法**用流内事件表达，只能由前端本地态呈现。
- **`task.created` 是合成事件**（`prependEvent`，id 恒为 `'0'`），不入持久化流，刷新即失。需要回溯的信息必须另发真事件（现由 `agent.routed` 承担）。
- **气泡是前端乐观创建的**，早于任何服务端事件；`agent.loop.start` 到达时气泡已在屏幕上。
- ~~**HITL 只在 ReAct 策略生效**~~ → **已失效**。plan/hybrid 已迁成 `StateGraph` 并接入审批（2026-08-10），审批不再是 ReAct 专属。

## P0 · 协议债

### 1. 事件载荷强类型化 ✅ 已完成

`packages/types/src/protocol/` 已按 `StreamTaskPayloadMap` 拆分（`events.ts`/`payloads.ts`/`factory.ts`/`strategy.ts`），收发两侧编译期约束，`AgentStrategyMode` 已上移。设计取舍（不引 zod 运行时校验、小程序发版节奏）如需回溯见 git 历史与 protocol 包注释。

### 2. 审批链路事件补全 ✅ 基本完成

- `ApprovalResolved` / `PlanReviewResolved` 已发，approve/reject/edit 后 trace 收敛到同一条（`recordApprovalResolved` / `recordPlanReviewResolved`）；`ApprovalRequired` / `PlanReviewRequired` 已入 trace（复用 `APPROVAL` 类型，靠 `nodeKey` 区分）。
- 剩余：结构化审批卡（见 P2）；`enhanceWithAi()` 仍 TODO。

> 任务生命周期事件（`TaskCreated/Started/Completed/Canceled/Expired`）不进 trace 是刻意的——`StreamTask` 表已有完整记录。`MessageDelta` 不进 trace 同理（量太大）。

## P1 · 多智能体协同

目标形态：一次提问由多个成员分工完成（「画师出图 + 文案配文」），进一步可按拓扑分发并由某个角色校验到收敛。

### 现状约束（决定性事实）

| 事实                                                                                                      | 位置                                                       |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| plan/hybrid 已跑在原生 `StateGraph` 上（`addNode`/条件边/`interrupt`）；ReAct 仍是 `createAgent()` 编译图 | `plan-graph.runner.ts`、`common-chat-agent.factory.ts`     |
| plan 与 hybrid 共用同一张图，差异只在 `collect_step` 后的条件边（hybrid 多问评估器）                      | `plan-graph.runner.ts`                                     |
| group-router 返回**单个** `agentId`，跑在建流之前，且在 `conversation` 模块，与 agent-loop 无连接         | `group-router.service.ts:68`、`stream-task.service.ts:179` |
| 1 StreamTask ↔ 1 assistant Message ↔ 1 `agentId` ↔ 1 SSE 流 ↔ 1 个 `fullContent` 列                       | `schema.prisma:216,221`                                    |
| trace 已有 `parentId` + `depth` 自关联——**层级已支持**                                                    | `schema.prisma:295,298`                                    |
| checkpointer 已是 Postgres 单例，`thread_id = taskId`                                                     | `agent-checkpointer.service.ts`                            |

后三条是净资产：图前置、trace 树形结构、持久化 checkpoint 都已就位——L2/L3 可直接在这套图上加循环（条件边）与扇出（`Send`）。

### 拆成三层看，成本差一个量级

**L1 · 并行多答**：N 个 agent 各自独立回答，互不依赖。
路由 schema `{agentId}` → `{answers:[{agentId, task}]}`（structured output 已接，这块便宜）+ 消息模型「一问一答」→「一问多答」+ 前端多气泡。**不需要新编排层，中等改动**，主要在数据模型和前端。

**L2 · 拓扑分发（DAG / dependsOn）**：需要一个跨 agent 的编排器，持有 DAG 状态、拓扑排序、把前驱产出注入后继上下文。
⚠️ `plan-graph.runner` 的 step 循环**形状像但不能直接复用**：它的执行单元是 step，全程共享同一个 `input.messages`、同一个 `llm`、同一套 tools；跨 agent 编排的每个节点要换 systemPrompt、工具集、模型预设和身份。这是新的一层，不是改造。**大改动**。

**L3 · 校验闭环**：循环 + 终止条件 + 全局预算 + 失败重试。三个真实风险：

- **无界循环烧钱**。`maxSteps` 是单 agent 内预算（默认 6），跨 agent 没有全局预算概念，校验不过就重跑没有闸门。
- **必须可中断恢复**。这一层动辄跑几分钟且中途可能撞 HITL。**图迁移后此点已解决**：图内节点粒度 + Postgres checkpointer，进程重启/断连可恢复。
- **router 干不了校验**。`GroupRouterService` 是 `temperature:0` + `maxOutputTokens:100` 的分类器（`group-router.service.ts:8-9`），只输出一个 id。校验要通读全部产出，是另一个角色（critic/supervisor），复用它会把 300ms 的轻量前置路由变成重调用，拖慢每条群聊消息。

### 关键设计决策：N 个流还是 1 个流

L1 就必须定，定错了 L2/L3 全部返工。**倾向：编排器一个父 StreamTask，每个 agent 一个子 StreamTask。**

- 复用现有全部机制——resume、trace、cancel、`fullContent`、HITL 全是 task 粒度
- trace 的 `parentId` 天然对应父子任务
- **HITL 冲突自然化解**：`WAITING_HUMAN` 落在子任务上，父任务等它；单流方案里两个 agent 同时要审批，task 级状态机直接打架
- 代价：schema 加 `parentTaskId`；前端并发订阅多流

⚠️ 小程序 SSE 走 `wx.request` + `enableChunked`（`api/request.ts:226`），微信并发请求上限 10，长任务会长时间占槽。3–4 个 agent 可行，再多需做流复用。

不推荐单流 + 事件打 `agentId` 标签：省连接数，但 `fullContent` 单列要拆、HITL 状态冲突无解、消息模型照样要改，不划算。

### 策略图迁移（原 P5b，L2/L3 的前置）✅ 已完成

plan/hybrid 已跑在 `StateGraph` 上（`plan-execute` 默认还带计划审批），`direct`/`react` 未动。完整实测结论、目标图形状、已定决策与遗留见 [plan-graph-migration.md](../apps/api/docs/plan-graph-migration.md)。**L2/L3 的图前置由此就绪**——循环用条件边、扇出用 `Send` 都能直接在这套图上加。

### 务实建议

别直接冲 L3。一次群聊提问触发 N 个 agent + 校验重跑，token 成本是单聊的 5–10 倍，延迟进分钟级。先把 L1 做出来跑一段，看真实场景里"需要依赖编排"的比例——很可能并行多答就覆盖了大部分，L2/L3 是长尾。

## P2 · 能力扩展

### 麦当劳 MCP 接入（P2-1 ✅）

`McpClientManager` 已接入 Nest 生命周期，作为 client、tools/list 缓存、审核白名单和健康快照的唯一所有者；`CapabilityRegistry` 显式等待其初始化，避免 provider 生命周期顺序造成空工具组。

- 仅将 8 个审核工具注册到 `mcd-order`：配送地址查询、附近门店、菜单/详情、门店优惠、计价、订单查询与创建订单。地址创建、自动领券、积分商城下单等外部账户写操作没有暴露。
- 工具保留 `mcdonalds__<原始工具名>` 运行时前缀，以避免多 MCP 同名冲突；白名单、审批和 trace 都基于原始 MCP 工具名，不依赖字符串猜测。
- **只有 `create-order` 需要人工审批**；它不在 `default` 组，普通聊天不会意外拥有下单权限。实际多步下单还会先经过 plan 的计划审批。
- 全局 `MCDONALDS_MCP_TOKEN` 代表一个会员身份，必须同时设置 `MCDONALDS_MCP_OWNER_USER_ID`；`mcd-order` 在路由、agent 配置和能力解析三层均只向该用户开放，避免地址、优惠与订单跨用户泄露。多用户开放前必须改为用户级 MCP 授权凭据。
- 已在 `conversation_trace` 的工具调用与工具审批节点写入 `mcpServer` / `mcpTool`。来源为后端审计信息，不扩展 SSE 协议。
- `MCDONALDS_MCP_TOKEN` / `MCDONALDS_MCP_OWNER_USER_ID` 缺失、鉴权失败、远端工具清单缺少审核工具时 API 启动失败，拒绝半可用或越权能力；真实连通性用 `node apps/api/scripts/debug-mcdonalds-mcp.cjs` 检查，脚本仅执行 tools/list。
- 首轮 `strategy.selected` 会把 `{ strategy, toolGroups, skills, maxSteps }` 写入 `StreamTask.executionState`；审批恢复以快照重建同一套工具、技能和审批集，默认 agent 的 `mcd-order` 不再退回 `default`。

**P2-2 待做**：新增规范化的外部订单表和订单结果持久化服务，令 `create-order` / `query-order` 成功结果可在消息列表完整回显；`payH5Url` 暂不持久化也不接微信支付。面向多用户开放前先实现用户级 MCP 授权凭据绑定。

### HITL 扩到 Plan/Hybrid（P5b）✅ 已完成

随策略图迁移一并落地，工具审批 + 计划审批 + 分步工具隔离均已端到端验证，见 [hitl.md](../apps/api/docs/hitl.md)。

### 结构化审批卡

`packages/types/src/protocol/approval-card.ts` 的 `ApprovalCardData` 与 `hitl/approval-card.builder.ts` **设计完成但从未接线**——`payload.card` 从没发出过。目前小程序已有两张手写卡：`ApprovalCard`（工具审批，渲染工具名 + JSON 参数）、`PlanReviewCard`（计划审批，可编辑步骤）。接上 schema 卡后可展示风险等级、结构化字段、预估费用；`enhanceWithAi()` 仍是 TODO。与麦当劳 MCP 下单配合价值最大（金额/餐品结构化展示）。

## P3 · 技术债

- **生图工具调用超时**：此前设了 3 分钟，根因（工具超时后 SSE 重连未走 resume）未定位。图迁移后节点粒度恢复可能已缓解，需复测确认。
- **`jsx-quotes` lint 报错**：`ChatWorkspace`、`pages/agents` 等文件的 JSX 属性引号不符合规则，属既有状态。清理会产生大量无关 diff，建议单独做一次格式提交。
- **群聊路由上下文窗口**：目前取尾部 4 条消息、每条截 120 字（`GROUP_ROUTE_CONTEXT_MESSAGES`）。若延续判断不够准可调大，但要权衡：路由是每条群聊消息的前置调用，得控制成本与延迟。
- **MCP 健康探测**：当前健康快照来自启动期 tools/list；后续多 MCP 时增加独立定时探测、退避和管理端可观测性。

## 建议顺序

```
P0-1 载荷强类型 ✅
   └─► 策略图迁移 + HITL(工具/计划) + 分步工具隔离 ✅（含端到端验证）
          │
          ├──► P2-1 麦当劳 MCP 工具接入 ✅
          │        ├─► P2-2 订单入库与消息回显
          │        └─► 结构化审批卡（配合 MCP 金额/餐品展示）
          │
          ├──► L1 并行多答（只卡消息模型，可与 MCP 并行开工）
          │
          └──► L2 拓扑编排（父子 task）──► L3 校验闭环（图前置已就绪）
```

- **两条可并行**：P2-2 与 L1 互不依赖。P2-2 门槛在「订单规范化数据模型与前端回显」，L1 门槛在「消息模型一问多答改造 + 前端多气泡」。
- **L2/L3 的图前置已就绪**（plan/hybrid 已在 StateGraph 上），但成本大、token 贵，务实建议见上：先把 L1 跑一段看真实依赖编排的比例。
- 收尾小项（doc、`executionState` 补字段）随手可做，不阻塞主线。
