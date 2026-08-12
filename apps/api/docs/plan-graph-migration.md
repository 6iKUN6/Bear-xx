# plan/hybrid 迁 StateGraph — 实施方案

> 更新于 2026-08-10。承接 `docs/next-steps.md` 的「策略图迁移」。
> 相关：[hitl.md](./hitl.md)（P5b 即本迁移的产物）、[agent-loop-evolution.md](./agent-loop-evolution.md)、[agent-chat-chain.md](./agent-chat-chain.md)

## 为什么做

`plan_execute` / `hybrid` 两个「策略图」是 27 行空壳，真正的编排在 `execution/agent-loop-controller.service.ts` —— 一个手写的 async generator，跑在 LangGraph 图**外**。由此产生三个缺口：

1. **无法审批**。checkpointer 只托管图状态，controller 不在图里 → plan/hybrid 永远不能中断/恢复。而多步任务（查询 → 选择 → 下单）恰恰最需要审批，这是 P2 麦当劳 MCP 的**硬前置**。
2. **无法断点恢复**。生图超时 / SSE 重连时整轮重跑。
3. **循环与扇出得手写**。L2 拓扑分发（`Send`）、L3 校验闭环（`addConditionalEdges`）现在等于自己实现一遍状态持久化。

`direct` 和 `react` **不迁**：前者是单次模型调用，套图纯增间接层；后者 `createAgent()` 返回的已是编译好的图，重画会丢掉 `interruptOn` / middleware 的上游维护。

## 已就绪的前提

### 实测结论（`scripts/debug-subgraph-interrupt.cjs`，已跑通）

脚本里搭的是**生产真实形状**：两步计划 + 条件边回环 + 每步重置 messages。结论：

1. **内层 HITL 中断能穿透外层**。外层 `getState()` 读得到 `actionRequests`，`next` 停在子图节点；外层 `Command({resume})` 能续跑内层并走完后续节点。**迁移的成败前提成立。**
2. **一次任务会多轮 `WAITING_HUMAN`**（实测 `resumeRounds=2`）。每个调用受审批工具的步骤各中断一次 —— ReAct 单轮只中断一次，迁移后多轮将成常态，任务状态机必须能反复进出等待态。
3. `createAgent()` 返回的 `ReactAgent` 是**门面对象、不是 Runnable 子类**，必须取 `.graph` 才能当节点（直接传会被 `_coerceToRunnable` 拒绝）。
4. `subgraphs: true` 下命名空间**首段即可区分来源**，无需读 metadata：
   - `execute:*_/model_request:*` → 内层步骤推理，收集为观察
   - `execute:*_/tools:*` → 工具结果
   - `synthesize:*` → 最终答案，下发 `message.delta`
   - 外层节点直接调模型是**单段**命名空间，子图是**两段**。
5. `RemoveMessage(REMOVE_ALL_MESSAGES)` + 重填可行，步骤隔离与 token 控制都保得住，**不必**给 agent 扩 state schema 去用 `dynamicSystemPromptMiddleware`。
6. 节点写进 state 的消息（remove/system/human）会混进 messages 流，现有解析里那句「`messageType !== 'ai'` 则 continue」正好滤掉，**解析器无需改动**。

### 已落地的代码

- `agents/common-chat-agent/agent-message-stream.mapper.ts`（纯函数模块）：`mapMessagesStream` 同时支持 `[message, metadata]` 与 `[namespace, [message, metadata]]`，产出 `{ event, namespace }`。ReAct 链路已切过去，零行为变更。
- `packages/types/src/protocol`：21 个事件载荷契约已收敛（`StreamTaskPayloadMap` + `createStreamEvent`），编排层事件类型已由 `AgentLoopWorkflowEvent` 从判别联合切出。**这是本次迁移的安全网**——迁移会重排事件发射点，无契约则字段错位不报错、只静默失效。

## 尚未解决的关键问题：编排事件桥接

消息桥接已解决，**编排事件桥接没有**。现在 `agent.loop.start`、`workflow.step.start/done`、`model.call.start/done` 是 controller 手写 `yield` 的，语义精确（中文 `publicStatus`、`traceKey`、`nodeKey` 都是刻意设计，前端 `streamFeedback.ts` 与 `conversation-trace.mapper.ts` 都依赖）。图节点里没有 `yield`，`streamMode:'messages'` 也拿不到节点边界。

两个方案：

| 方案 | 做法 | 评价 |
|---|---|---|
| `updates` 流反推 | `streamMode: ['messages','updates']`，从节点产出推断进出 | ✗ updates 只在节点**完成后**到达，`step.start` 只能靠上一节点推断；与 messages 的相对顺序是尽力而为；`publicStatus` 等展示字段要在流消费侧重新编，语义被拆到两处 |
| **`custom` 流 + `writer()`** | 节点内直接 `writer(createStreamEvent(...))` 推出成品事件 | ✓ 事件语义留在节点内（与现在 controller 的写法一一对应），顺序天然正确，载荷直接复用契约 |

**取 `custom` 方案，已实测通过**（`scripts/debug-graph-events.cjs`，`@langchain/langgraph@1.4.7`）。与根 AGENTS.md 的禁令不冲突：禁的是 `streamEvents({version:'v3'})`，`stream({streamMode})` 不受影响。

实测结论：

1. **顶层导出的 `writer(chunk)` 是静默失效的。** 在节点里调用不抛错、也不产出任何 custom 块。必须用 **`config.writer(chunk)`**（节点第二参）或 `getWriter()`。类型签名完全正常，编译期与运行期都不报错——只能实测发现，是本次最容易踩空的一处。
2. 多模式 + `subgraphs:true` 的块确为 **3 元组 `[namespace, mode, payload]`**（单模式 + subgraphs 是 2 元组）。**现有 `mapMessagesStream` 只认 2 元组，必须先补一层解复用。**
3. **custom 与 messages 的命名空间规则不同**：custom 恒为 `[]`（root，看不出发自哪个节点），messages 是外层节点 1 段、子图内 2 段。→ **编排事件的归属信息必须写进载荷（`nodeKey` / `step`），不能靠命名空间推。**

   ⚠️ **区分「最终答案 vs 内部过程文本」必须白名单 `synthesize`，不能用段数黑名单子图。** 早先按「≥2 段丢弃」只挡住了子图（step 推理），却漏了 `create_plan` 这个**外层节点**：真实 planner 走 `generateStructured`，在节点内 invoke 了一次模型，`streamMode:'messages'` 会捕获它的 token，命名空间是单段 `['create_plan:*']`——于是 planner 的计划 JSON 直接漏成了正文（线上现象）。正解是 `namespace[0]` 的节点名 === `synthesize` 才放行 `message.delta`，其余（planner / 步骤推理）一律拦在内部。见 `debug-plan-graph.cjs` 的 `a.planner-leak-check`。
4. **顺序正确且稳定**：`step.start#step-1` → `prepare_step` 的 system/human → `execute` 的 ai 块；`model.call.start` → `synthesize` 的 ai 块 → `model.call.done` → `step.done`。前端卡片不会先出内容后出标题。
5. **custom 不重放**（本次最大未知风险，已清除）：turn1 发过 create_plan 的三条 + step-1 的 start，两轮 resume 只发各自新增的事件，无一重复。中断节点之前的节点不会重跑。
6. 子图**内层**（工具执行上下文）`getWriter()` 拿不到 writer，写不出 custom。生产不依赖——工具事件走 messages 流（`ToolMessage` → `tool.call.done`），编排事件只从外层节点发。

## 目标图形状

```
START → create_plan → prepare_step → execute(子图) → collect_step ─┬─(还有步骤)→ prepare_step
                                                                    └─(收尾)────→ synthesize → END
```

- `execute` = `createAgent().graph`，**内层不挂 checkpointer**（由外层提供，否则各存各的、无法联动）。
- hybrid 与 plan **只差 `collect_step` 后的条件边**：hybrid 额外过 `StepEvaluator` 判断能否提前收尾。共用一个 builder，不要复制两份图。
- 节点名不能与状态字段重名（LangGraph 直接报错），故用 `create_plan` —— 正好与现有 `STEP_TITLES` 的 key 一致。

状态：`messages`（复用 `MessagesAnnotation.spec`）+ `plan` + `stepIndex` + `observations`。

## 分步实施

每步单独可验证、可回滚；每步跑 `pnpm --filter ./apps/api run build` + `lint:check`。

### 步骤 0 · 补齐事件桥接实测 ✅ 已完成

`scripts/debug-graph-events.cjs`，四个问题全部有答案，结论见上节与脚本头注释。**方案成立，可以往下走。**

### 步骤 1 · 流解复用 ✅ 已完成

`agent-message-stream.mapper.ts` 新增 `mapGraphStream(stream)`：3 元组按 `mode` 分流 —— `messages` 走现有解析，`custom` 的 payload 本身就是成品 `AgentLoopStreamEvent`，直接透传。产出仍是 `{ event, namespace }`。

两个入口共用一份块解析：原生成器里的解析体抽成 `createMessageChunkParser()`（有状态闭包，工具 args 分片要跨块累积），`mapMessagesStream` 与 `mapGraphStream` 各自只负责拆入流形状。

注意 custom 的 `namespace` 恒为 `[]`，消费侧**不能**用「命名空间为空」当作「来自外层节点的模型输出」的判据——那是 messages 才有的语义。

**ReAct 链路不动**（继续走 `mapMessagesStream` 单模式），本步零行为变更。

### 步骤 2 · 落地编排图 ✅ 已完成

`execution/plan-graph.runner.ts`（文件名与最初设想的 `plan-graph.builder.ts` 不同：它既建图也消费流，叫 runner 更实），`graphs/plan-execute.graph.ts` 与 `graphs/hybrid-plan-react.graph.ts` 退回成 27 行的薄壳，转发给它。`agent-loop-controller.service.ts` 已删除。

- `create_plan` 调 `PlannerService.plan()`，发 `workflow.step.start/done`（含 `buildPlanReadySummary`）。
- `prepare_step` 用 `RemoveMessage(REMOVE_ALL_MESSAGES)` 重置 messages，注入本步提示词 + 原始对话。
- `execute` = `agentFactory.createAgent({model, tools}).graph`，**不带 systemPrompt**（每步提示词由 `prepare_step` 注入，不能在建图时固定）。
- `collect_step` 取末条 ai 文本收为 observation，推进 `stepIndex`，并记下本步是否用过工具（hybrid 评估器要）。
- `synthesize` 不带工具做一次收敛回答，其 `message.delta` 是**唯一**下发给用户的正文。
- 条件边 `shouldContinue` 与原 controller 循环逐条对应：步骤跑完或撞 `maxSteps` 收尾；hybrid 额外过 `StepEvaluator`。

原样搬运：`buildStepPrompt` / `buildSynthesisPrompt` → `execution/plan-prompt.builder.ts`；`toLangChainMessages` → `agents/common-chat-agent/llm-message.mapper.ts`（ReAct 链路同时改用它，消除重复）。

**本步刻意不打开 HITL**：inner agent 不挂 checkpointer、不传 `approvalToolNames`，行为与迁移前的 controller 完全等价。原因是恢复路径（步骤 4）还没改——先开中断会让 plan/hybrid 任务进 `WAITING_HUMAN` 后被 ReAct agent 恢复，thread 状态对不上。**HITL 与恢复必须同一步打开。**

`GRAPH_RECURSION_LIMIT = 60`：每步占 3 个超步，默认 25 会卡在长计划上；真正的步数闸门仍是 `maxSteps`。

### 步骤 3 · 事件等价性回归（部分完成）

已做：`scripts/debug-plan-graph.cjs` 跑**生产代码本身**（dist 里的 `PlanGraphRunner` + 真实模型 + 真实工具，只替身 planner/llmService/evaluator），实测事件序列与迁移前 controller 逐项一致：

```txt
agent.loop.start
workflow.step.start#create_plan → done#create_plan
workflow.step.start#step-1 → tool.call.start → delta x6 → done → workflow.step.done#step-1
workflow.step.start#step-2 → workflow.step.done#step-2
workflow.step.start#synthesize → model.call.start → message.delta x45 → model.call.done → done#synthesize
```

要点全部成立：`message.delta` **只**来自 synthesize（步骤过程文本被滤掉）、工具事件照常穿透、两个步骤都跑到。

未做：端到端过 HTTP + DB 的比对（`stream_task_events` 表的序列与前端渲染）。这一项要等真实会话跑一次，属于上线前验证。

### 步骤 4 · 打开 HITL + 恢复路径改造 ✅ 已完成

**这一步才让 plan/hybrid 具备审批能力**（步骤 2 只搬了编排载体，行为等价）。两件事同一步做完，避免「能中断但恢复不了」的坏中间态。

落地内容：

- **HITL 共用逻辑抽出** → `agents/common-chat-agent/agent-hitl.ts`：`buildHitlMiddleware` / `readInterruptValue` / `emitPendingApproval` / `buildHitlResponse`。ReAct 链路同时改用它（零行为变更），两边不再各写一份。
- **编排图接入**：外层图 `compile({ checkpointer })`（`thread_id = taskId`），内层子图挂 `humanInTheLoopMiddleware` 但**不挂 checkpointer**；流结束后读 `getState()` 发 `approval.required`（`nodeKey = plan_graph_approval`，与 ReAct 的 `common_chat_approval` 区分来源）。
- **`PlanGraphRunner.resume()`**：重建同形状的图 → 读中断值 → `Command({resume})` 续跑 → 再检测一次挂起。首轮与恢复共用 `consume()` 消费流，两条路径事件必然一致。
- **`AgentStrategyGraph.resume?()`**：ReAct / plan / hybrid 三个图实现，direct 不实现（无工具，永不挂起）。`AgentLoopRunnerService.resume()` 按持久化的策略分发；找不到 `resume` 直接抛错，不静默重跑。
- **策略持久化**：`strategy.selected` 到达时把 `{ strategy }` 写进 `StreamTask.executionState`（既有 Json 列，**无需 Prisma 迁移**）；恢复时读回。缺失/非法回退 `react`（老任务只可能是 ReAct 挂起的）。
- **`resumeConversationRun`** 改为经 `AgentLoopRunnerService.resume()` 分发，不再直连 agent 层；并把 `messages` 从 `[]` 改为真实上下文——ReAct 恢复只用检查点会忽略它，但编排图的节点闭包（`prepare_step` / `synthesize`）需要原始对话。

**实测（`scripts/debug-plan-graph.cjs` 场景 B，真实模型 + 生产代码）**：

```txt
turn1     : … step.start#step-1 → tool.call.start → delta x6 → approval.required   工具未执行 ✓
resume #1 : tool.call.done → step.done#step-1 → step.start#step-2 → … → approval.required
resume #2 : tool.call.done → step.done#step-2 → synthesize → 最终答案
→ PLAN_HITL_OK，resumeRounds = 2，工具确实执行
```

两轮 `WAITING_HUMAN` 正是步骤 0 预测的常态——每个调用受审批工具的步骤各中断一次。

**遗留**：`toolGroups` / `skills` 未持久化，多工具组场景下恢复时重建的工具集仍可能与首轮不一致（`hitl.md` 已记录）。

### 步骤 5 · 清理与文档

- ~~删除 `execution/agent-loop-controller.service.ts`~~ → 已随步骤 2 删除（含 DI 注册与 barrel 导出）。
- ✅ 更新 `hitl.md`：P5b 从「延后」改为已实现，补 plan/hybrid 的差异与恢复路径。
- ✅ 更新 `docs/next-steps.md` 进度。
- 待办：更新 `agent-loop-evolution.md`。

## 分步工具隔离（修复「每步都调 generateImage」）

**现象**：plan_execute 里 generateImage 在每一步都被调用（查天气、给建议、生成图三步各一次），触发多次 HITL。

**根因（实测 `debug-plan-graph.cjs` 场景 D + 若干探针）**：两条独立事实叠加——
1. 每步共用同一个 ReAct 执行器（单一编译子图，为 HITL 穿透与流式不能每步换执行器），拿到**全部工具**。
2. **把编译子图作为外层节点嵌入时，`prepare_step` 通过 messages 注入的前导步骤提示词到不了子图的模型调用**——子图只看到原始对话（无论用 System 还是 Human 注入都被丢弃；探针确认只有 state 通道能穿透）。于是每步模型都看到完整用户请求 + 全部工具，把后续步骤的 generateImage 也顺手调了。软约束（prompt）压不住。

**修复**：`execution/step-tool-scope.ts` 的 `StepContext` 中间件，经 **state 通道**（`stepInstruction` / `stepAllowedTools` / `scopedApprovalTools`）注入：
- 把本步提示词作为该步模型调用的 `systemPrompt` 送达（补上 messages 注入到不了的洞）；
- 硬隔离工具：**被隔离的审批工具只在明确安排它的步骤可见，只读工具始终可见**。「需隔离的审批工具」= 审批工具 ∩「计划里被某步 `suggestedTools` 标注过」——计划从没安排的审批工具不隔离，避免锁死到不可调用。

配套：`task-planner.md` 要求每步都给 `suggestedTools`（生图等动作必须落在明确列出对应工具的步骤）。实测场景 D：generateImage 现在只在 step-3 审批/执行一次（`OK_SINGLE_IMAGE_IN_STEP3`）。

> ⚠️ 遗留：若 planner 始终不标注某审批工具，则它不被隔离（退回原行为）——靠强化后的 planner 提示词兜底，非硬保证。

## 剩余收尾

1. **端到端验证**（唯一的实质缺口）：过 HTTP + DB 跑一次真实会话，确认 `stream_task_events` 序列、`WAITING_HUMAN` 多轮进出、前端审批卡片渲染都正常。需要起服务。
2. `agent-loop-evolution.md` 补一节。
3. `toolGroups` / `skills` 一并写进 `executionState`（见步骤 4 遗留）。

## 已定决策

| 决策 | 结论 | 依据 |
|---|---|---|
| 编排事件怎么发 | `custom` streamMode + 节点内 **`config.writer()`** | 语义留在节点内，顺序天然正确；`updates` 反推会把语义拆两处。顶层 `writer()` 静默失效，勿用 |
| 子图怎么嵌 | `createAgent().graph` | `ReactAgent` 是门面对象，实测得出 |
| 内层 checkpointer | 不挂，由外层提供 | 各存各的无法联动 |
| 步骤间上下文隔离 | `RemoveMessage(REMOVE_ALL_MESSAGES)` + 重填 | 实测可行，比扩 state schema 简单 |
| plan 与 hybrid | 共用一个 builder，差异在条件边 | 现在就是共用代码 + 一个 boolean |
| 来源区分 | 命名空间首段（子图两段 / 外层单段） | 实测得出，无需读 metadata |

## 待定决策（动手前需拍板）

1. **无审批工具时要不要也挂 checkpointer？**
   挂 → 「断点恢复」价值兑现，但每个 plan 任务都往 Postgres 写检查点。
   不挂 → 维持现状（仅有审批工具时挂），本次迁移只兑现「HITL 覆盖」。
   *倾向先不挂*，断点恢复单独作为一步评估写入量后再开。

2. **observations 的长度控制。** 调试脚本里是 `slice(0, 80)`，生产不能这么截。要么按 token 预算截断，要么让每步 prompt 显式要求简短产出（现有 `buildStepPrompt` 已有此约束，可能够用）。

3. **`synthesize` 是否也该走 custom 发 `model.call.start/done`。** 现在 controller 手工发了这一对；图里 `synthesize` 是外层节点直接调模型，可以照发，但要确认与命名空间区分逻辑不冲突。

## 风险

- ~~custom 块在 resume 时重放~~ → **已排除**（步骤 0 实测，无重放）。
- **事件顺序隐含依赖** → 前端按到达顺序折叠卡片（`traceKey`），迁移后顺序若变会渲染错乱。靠步骤 3 的序列比对兜住。
- **多轮 `WAITING_HUMAN`** 是新常态，审批端点与任务状态机需回归。
- **误用顶层 `writer()`** → 静默丢事件，无任何报错。落地时统一走 `config.writer`，code review 需盯这一点。

## 验证命令

```bash
node apps/api/scripts/debug-subgraph-interrupt.cjs   # 中断穿透（已通过）
node apps/api/scripts/debug-graph-events.cjs         # 事件桥接（已通过）
node apps/api/scripts/debug-plan-graph.cjs           # 编排图冒烟，需先 build（已通过）
node apps/api/scripts/debug-planner.cjs
node apps/api/scripts/debug-hitl.cjs
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check
```

## 涉及文件

| 层 | 文件 | 动作 |
|---|---|---|
| 解析 | `agents/common-chat-agent/agent-message-stream.mapper.ts` | ✅ 加 `mapGraphStream` + 共用块解析 |
| 消息 | `agents/common-chat-agent/llm-message.mapper.ts` | ✅ 新建（从 loop service 抽出） |
| 图 | `agent-loop/execution/plan-graph.runner.ts` | ✅ 新建 |
| 图 | `agent-loop/graphs/{plan-execute,hybrid-plan-react}.graph.ts` | ✅ 转发给 runner |
| 提示词 | `agent-loop/execution/plan-prompt.builder.ts` | ✅ 从 controller 抽出 |
| DI | `ai.module.ts`、`agent-loop/index.ts` | ✅ 换注册 |
| 删除 | `agent-loop/execution/agent-loop-controller.service.ts` | ✅ 已删 |
| HITL | `agents/common-chat-agent/agent-hitl.ts` | ✅ 新建（两条链路共用） |
| 编排 | `agent-loop/agent-loop.types.ts` | ✅ `AgentStrategyGraph` 加可选 `resume` |
| 编排 | `agent-loop/agent-loop-runner.service.ts` | ✅ 加 `resume()` 按策略分发 |
| 策略图 | `graphs/{common-react,plan-execute,hybrid-plan-react}.graph.ts` | ✅ 实现 `resume` |
| 恢复 | `agents/common-chat-agent/common-chat-agent-runner.service.ts` | ✅ 改走 agent-loop |
| 任务 | `stream-task/stream-task.service.ts` | ✅ 写/读 `executionState` |
| 诊断 | `scripts/debug-graph-events.cjs`、`scripts/debug-plan-graph.cjs` | ✅ 已建 |
