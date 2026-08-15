# HITL（人工审批）— P5

> 工具级人工审批：模型在执行受控工具前暂停，等待人工 approve / reject / edit，再从中断处续跑。
> 基于 LangChain v1 `humanInTheLoopMiddleware` + LangGraph `checkpointer` + `Command` 恢复。
> 相关链路见 [agent-chat-chain.md](./agent-chat-chain.md)、[stream-task-architecture.md](./stream-task-architecture.md)。

## 范围

- **P5a（已实现）**：**ReAct** 策略的工具级审批。
- **P5b（已实现）**：**Plan/Hybrid** 的中途工具审批。手写 JS 编排已迁成 `StateGraph`（见 [plan-graph-migration.md](./plan-graph-migration.md)），编排状态与内层中断都由外层 checkpointer 托管。
- **P5c（已实现）**：**计划审批**（plan_execute 默认开）。出计划后、执行第一步前暂停，用户可通过/编辑步骤（改文字+末尾追加）/带意见打回重规划/终止。见下方「计划审批」专节。
- **Direct** 无工具，永不挂起，不实现 `resume`。

### Plan/Hybrid 与 ReAct 的两处差异

1. **一次任务会多轮 `WAITING_HUMAN`。** 每个调用受审批工具的**步骤**各中断一次；ReAct 单轮通常只中断一次。实测两步计划 = `resumeRounds: 2`。任务状态机必须能反复进出等待态（现有实现可以：resume 后再次检测挂起即再置 `WAITING_HUMAN`）。
2. **中断发生在子图内，但外层读得到。** `execute` 节点是内层 ReAct 子图，HITL 中间件挂在它上面；中断穿透到外层，外层 `getState()` 读得到 `actionRequests`，外层 `Command({resume})` 也能续跑内层。**内层刻意不挂 checkpointer**——各存各的就无法联动。
3. `approval.required` 的 `nodeKey` 区分来源：ReAct 链路 `common_chat_approval`，编排图链路 `plan_graph_approval`。

## 端到端流程

跨两个 HTTP 请求：首轮流（暂停）+ 审批端点（恢复）。

```
① POST /api/chat/message ─► StreamTask(STREAMING)
   runChatTask → prepareConversationRun(taskId 作为 thread_id)
     → ReAct: createAgent({ checkpointer, middleware:[hitl] })
        agent.stream(input, { streamMode:'messages', configurable:{ thread_id: taskId } })
     → 模型提议 generateImage（已配 requiresApproval）→ hitl 中间件在工具执行前 interrupt()
   loop 结束 → getState 检测挂起中断 → 发 approval.required 事件
   runChatTask 检测到 pendingApproval → 任务置 WAITING_HUMAN，不落 message.done / COMPLETED
   （检查点已持久化，图暂停；SSE 首轮流结束）

② 前端收到 approval.required → 展示 通过/拒绝/改参 卡片

③ POST /api/stream-tasks/:taskId/approval  { decision, editedArgs?, reason?, lastEventId? }
   resumeTaskWithDecision：校验 WAITING_HUMAN + 归属 → 决定写入 Redis(hitl:approval:<taskId>)
     → 持久化 approval.resolved 并收敛同一条审批 trace
     → 复用 createTaskStream → ensureTaskExecution → runTask → runChatTask
   runChatTask 读到待处理决定 → 走 resumeConversationRun：
     同 thread_id + 全量 tools + 审批策略重建 agent
     → agent.stream(new Command({ resume: HITLResponse }), config)
       approve → 执行工具 / reject → 回注拒绝 / edit → 用改后入参执行
   续跑 → message.delta … → COMPLETED（或再次中断 → 再 WAITING_HUMAN）
```

关键：**同一 `checkpointer`（进程单例）+ 稳定 `thread_id`（= taskId）**。重建 agent 对象无所谓，图状态从 checkpointer 按 thread_id 取回。

## 检查点存储

`AgentCheckpointerService` 用 `PostgresSaver`（`@langchain/langgraph-checkpoint-postgres`），表建在独立的 **`langgraph` schema**：

- **为什么是 Postgres 而非 Redis**：任务状态 `StreamTask.status=WAITING_HUMAN` 落在 Postgres，检查点必须与它同生共死。放 Redis 会出现「任务行说等待审批、图状态已被 TTL/淘汰清掉」，恢复时找不到中断点 → 任务永久卡死。审批间隔可能数分钟到数小时，不适合有过期语义的缓存。
- **为什么独立 schema**：这些表由 LangGraph 的 `setup()` 自建自管（含自身迁移），不进 Prisma 迁移历史；隔离后 `prisma migrate` 不会把它们当 schema 漂移。
- **无需额外配置**：复用 `DATABASE_URL`；`setup()` 幂等（`CREATE SCHEMA / TABLE IF NOT EXISTS`），每次启动自动对齐。

## 协议契约（前后端共享，`@litter-bear/types/protocol`）

- 事件 `StreamTaskEventType.ApprovalRequired = 'approval.required'`，中文文案「待人工确认」。
- `approval.required` 载荷 `ApprovalRequiredPayload`：
  ```ts
  { toolCallId?, toolName?, args?(序列化), description?, allowedDecisions: ApprovalDecisionType[],
    index?, nodeKey?, traceKey?, publicStatus? }
  ```
- 人工决定 `ApprovalDecision`：`{ decision: 'approve'|'reject'|'edit', editedArgs?, reason? }`。

## 审批端点

`POST /api/stream-tasks/:taskId/approval`（`@Sse`），Body = `SubmitApprovalDto`：
`{ decision, editedArgs?, reason?, lastEventId? }`。仅对 `WAITING_HUMAN` 任务生效，返回续跑的 SSE 流（复用断线重连/缓冲机制）。

三态语义（映射到 LangGraph HITLResponse.decisions）：
- **approve** → `{ type:'approve' }` → 按原参执行工具。
- **reject** → `{ type:'reject', message:reason }` → 不执行，向模型回注拒绝说明。
- **edit** → `{ type:'edit', editedAction:{ name, args:editedArgs } }` → 用改后入参执行。

## 能力策略（哪些工具要审批）

`CapabilityRegistry.registerTool(tool, groups, { requiresApproval })`。`CapabilityResolver` 产出本次装配中的 `approvalToolNames`（resolved tools ∩ requiresApproval），沿 agent 层透传，驱动 `humanInTheLoopMiddleware` 的 `interruptOn`。

同一套 `approvalToolNames` 同时驱动 ReAct 的 agent 与编排图的**内层子图**——`agent-hitl.ts` 的 `buildHitlMiddleware()` 两边共用，审批语义不会漂移。

当前策略：
- **免审批**（只读、无副作用）：`getWeather`、`webSearch`。
- **需审批**：`generateImage`（`image-gen` 组）——单次调用产生真实模型费用且耗时，approve 前用户可在卡片里改 `prompt`/`size`，reject 则不产生任何模型调用与七牛资产。
- **需审批（用户级 MCP）**：麦当劳 `create-order`。它只在任务锁定了活跃凭据且通过工具审核后动态装配；无论运行时前缀为何，`CapabilityRegistry` 均按原始 MCP 工具名识别并要求审批。

> 早期曾临时给只读的 `getWeather` 开审批用于跑通链路（P5a 演示），已还原——审批语义应落在真正有副作用/有成本的工具上。

## 当前持久化边界

审批等待的业务事实不只在 Redis：

1. Agent 发出 `approval.required` 或 `plan.review.required` 后，`StreamTaskService` 持久化低频 `StreamTaskEvent`；trace mapper 创建同一任务下 `ConversationTurnTraceItem(APPROVAL, RUNNING)`。
2. 事件流结束后，任务才投影为 `StreamTask.status=WAITING_HUMAN`。LangGraph checkpoint 存在 PostgreSQL 的 `langgraph` schema，可按 `thread_id=taskId` 找回中断点。
3. 审批端点先把决定写入 Redis 的 `hitl:approval:<taskId>` 或 `hitl:plan-review:<taskId>`（TTL 与 SSE 缓冲期一致），再持久化 `*.resolved` 事件并将同一条 trace 收敛为 `SUCCESS`。
4. 后台续跑消费一次 Redis 决定后以 `Command({ resume })` 恢复；如果再次中断，重复上述过程。

当前这些步骤是同步顺序调用，不是跨 `StreamTask`、`StreamTaskEvent`、trace 与 Redis 的单一事务；trace 写入失败只告警而不阻断续跑。因此当前 `WAITING_HUMAN` 是已落 PostgreSQL 的 HITL 等待态，但“哪个决定尚待消费”仍由 Redis 临时保存。这也是 AgentFlow/Temporal 设计改为“数据库决议与 trace 先落库，再经 outbox Signal 恢复”的原因。

## 计划审批（P5c，plan_execute 默认开）

与工具审批**是两套独立中断**，但共用 `WAITING_HUMAN` 状态机、checkpointer 与续跑管道：

| | 工具审批 | 计划审批 |
|---|---|---|
| 中断点 | 子图内 `humanInTheLoopMiddleware`（工具执行前） | 外层 `review_plan` 节点的 `interrupt()`（出计划后、第一步前） |
| 判别 | 中断值含 `actionRequests` | 中断值 `{ kind:'plan-review', steps, revision }` |
| 事件 | `approval.required` | `plan.review.required`（`nodeKey=plan_review`） |
| 端点 | `POST :taskId/approval` | `POST :taskId/plan-review`（`SubmitPlanReviewDto`） |
| Redis | `hitl:approval:<taskId>` | `hitl:plan-review:<taskId>` |
| 决定 | `ApprovalDecision` | `PlanReviewDecision` |

**开关**：`strategy === plan_execute && 有 threadId` 即开（`PlanGraphRunner.isPlanReviewEnabled`）。计划审批需要 checkpointer，故 `needsCheckpoint = 有审批工具 || 计划审批`。

**图形状**：`create_plan → review_plan ─┬ proceed→prepare_step ├ replan→create_plan └ terminate→END`。`review_plan` 在 `interrupt()` 后按决定写 `reviewOutcome`，条件边据此路由。

**四种决定**（`PlanReviewDecision`，直接作为 `interrupt()` 的 resume 返回值）：
- **approve** → 按当前计划执行。
- **edit** → `editedSteps`（改后文字 + 追加）重编号成新 `plan`，再执行。
- **reject_replan** → `feedback` 累积进 `planFeedback`，回 `create_plan` 带意见重规划 → 新一轮 `plan.review.required`（`revision+1`）。
- **reject_terminate** → 到 `END`，不经 synthesize；`PlanGraphRunner` 补发一条固定「已终止」`message.delta`（否则助手气泡空白）。

**组合流**：plan_execute + 有审批工具时，先计划审批，approve 后逐步执行，含审批工具的步骤再各自中断。实测 `debug-plan-graph.cjs` 场景 B（`PLAN_HITL_OK`：先 plan 后 tool）、场景 C（`PLAN_REVIEW_OK`：四种决定齐全）。

**trace**：计划审批 trace 复用 `APPROVAL` 类型（避免枚举迁移），靠 `nodeKey=plan_review` / `traceKey=plan-review` 区分；`plan.review.resolved` 收敛同一条 RUNNING 项。

## 关键实现点

- **中断检测**：不解析消息流。首轮流结束后 `agent.getState({configurable:{thread_id}})`，`state.tasks[].interrupts[].value` 即 `HITLRequest`：
  `{ actionRequests:[{name,args,description?}], reviewConfigs:[{actionName,allowedDecisions}] }` → 映射为 `approval.required`。
- **恢复**：`agent.stream(new Command({ resume: { decisions: [...] } }), config)`。每个 actionRequest 对应一个 decision。
- **thread_id = taskId**：初始运行与恢复共享。
- **任务状态**：`StreamTaskStatus.WAITING_HUMAN`（数据库枚举已预留，非终态；`isTerminalStatus` 不含它，故恢复能顺利触发执行）。
- **决定传递**：审批端点把决定写 Redis `hitl:approval:<taskId>`（TTL=缓冲期），后台 `runChatTask` 读取一次即消费，据此选 resume 路径。

## 恢复的重建策略与边界

恢复**不重新路由**，但必须交回**首轮那个策略图**——检查点里存的是它的图状态（ReAct 存 agent 图、plan/hybrid 存编排图），换个形状的图就对不上。

为此首轮的策略与能力快照要持久化：`strategy.selected` 事件到达时，`StreamTaskService.persistExecutionStrategy()` 把 `{ strategy, toolGroups, skills, maxSteps, mcdonaldsCredentialId }` 写进 `StreamTask.executionState`（既有 Json 列，无需迁移）。恢复时 `readExecutionStrategy()` 取策略交给 `AgentLoopRunnerService.resume()` 分发到对应策略图；`resolveResumeCapabilities()` 用快照重建首轮同一套工具、技能、审批集以及任务锁定的 MCP 凭据。

> 该列缺失或非法时回退 `react`：本字段上线前创建的老任务只可能是 ReAct 挂起的（当时只有 ReAct 支持审批）。若策略与实际不符导致图找不到 `resume`，**直接抛错**而不是静默重跑——这是必须暴露的状态不一致。

工具与提示词由 `AgentLoopRunnerService.resolveResumeCapabilities()` 按首轮快照装配（与受限主链路一致，不用全量工具）；老任务快照缺失时才回退旧的 agent 配置/default 装配逻辑。

其它边界：
- **检查点降级**：`AgentCheckpointerService` 正常使用 Postgres（`langgraph` schema，见下）；仅当 `DATABASE_URL` 缺失或 `setup()` 失败时才退回进程内 `MemorySaver`，此时重启会丢挂起状态——启动日志会以 error 级别告警，不要忽略。
- **中断前的助手文本**：若模型在工具调用前输出过文本，暂停时未并入最终 message，恢复后的 message 只含续跑文本（P5a 常见流程是先调工具，无此问题）。
- **approval.required 无 toolCallId**：`HITLRequest.actionRequests` 不带工具调用 id，前端按 toolName + 最近的 tool.call.* 关联即可。

## 涉及文件

| 层 | 文件 |
|---|---|
| 协议 | `packages/types/src/protocol/index.ts` |
| 能力 | `agent-loop/capability/capability.{registry,resolver,types}.ts` |
| checkpointer | `agents/common-chat-agent/agent-checkpointer.service.ts` |
| **HITL 共用逻辑** | `agents/common-chat-agent/agent-hitl.ts`（中间件 / 读中断 / 发 approval.required / 决定映射，两条链路共用） |
| agent 层 | `agents/common-chat-agent/common-chat-agent-{factory,loop,service,runner}.service.ts` + `*.types.ts` |
| 编排图 | `agent-loop/execution/plan-graph.runner.ts`（plan/hybrid 的中断与恢复） |
| 分发 | `agent-loop/{agent-loop.types,agent-loop-runner}.ts`、`graphs/{common-react,plan-execute,hybrid-plan-react}.graph.ts` |
| 任务/端点 | `stream-task/stream-task.{service,controller}.ts`、`dto/submit-approval.dto.ts` |
| 诊断 | `scripts/debug-hitl.cjs`（ReAct）、`scripts/debug-plan-graph.cjs`（plan/hybrid） |

## 验证

`node scripts/debug-hitl.cjs`（真实模型，独立于 HTTP）已验证 ReAct 的核心机制：
- turn1：工具**未执行**（工具执行前中断）；
- `getState` 读出 `actionRequests`/`reviewConfigs`（结构与解析一致）；
- `Command({resume:{decisions:[{type:'approve'}]}})` 续跑 → **工具执行** → 最终答案。

`node scripts/debug-plan-graph.cjs`（需先 `build`，跑 dist 里的真实 `PlanGraphRunner`）已验证 plan/hybrid：
- turn1：`approval.required`（`toolName=getWeather`、`args={"city":"深圳"}`、三态决定齐全），工具**未执行**；
- `runner.resume()` 续跑 → `tool.call.done` → 步骤推进 → **第二个受审步骤再次中断**；
- 第二轮恢复 → `synthesize` → 最终答案。`resumeRounds: 2`，工具确实执行。

配合 `pnpm build` + `lint` 全绿。

**端到端（HTTP + DB + 前端审批卡片）尚未验证**，为收尾项。
