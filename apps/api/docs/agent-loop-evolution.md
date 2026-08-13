# Agent 对话链路重构记录（P0–P5）

> 一次从「修一个工具调用 bug」滚动成「重设计整条 agent 链路 + monorepo 化 + 人工审批(HITL)」的演进记录。
> 目的：留住**设计思维**与**取舍理由**（"为什么这么做"），而不仅是结果。细节实现见文末关联文档。

---

## 一、起点：为什么要动

原链路（`StrategyRouter → StrategyRegistry → {Direct/ReAct/Plan/Hybrid}Graph`）问题集中：

- **决策与执行脱节**：路由算出的 `toolGroups / skills / maxSteps` 只发给前端，从不影响真正执行（死字段）。
- **能力错配**：路由关键词含"麦当劳/点餐"，但只有 `getWeather` 一个工具——承诺了不存在的能力。
- **Plan/Hybrid 是假的**：只发"已完成拆解"之类假 step，实际走直答，且不带工具。
- **双 LLM 链路**：Direct 走 `llmService.streamChatText`，ReAct 走 `createAgent`，两套实现两套行为。
- **脆弱兜底**：靠 `message.includes('call_id')` 字符串匹配来降级。

**触发点**：前端问「深圳天气」工具调不动，报 `400 No tool call found for function call output`（`fc_` 前缀 call_id）。

---

## 二、贯穿始终的设计原则

这几条在每个阶段反复出现，是这轮重构真正的"思维主线"：

1. **诚实链路**：不承诺没有的能力；不发假 step、不把"待办/暂停"误判成"完成"。
2. **决策必须接线**：决策产出的字段要真正驱动执行，否则就是技术债（消除死字段）。
3. **统一执行核心**：一条 executor 收敛所有模式，避免行为分叉与重复维护。
4. **闭集能力装配**：能力从注册表闭集解析，路由只能选已存在的能力。
5. **增量 + 每阶段可验证 + 停下 review**：大改拆成能单独 build/lint/跑通的小步。
6. **实证优先的调试**：用最小复现脚本定位根因，不猜 API、不猜根因（多次救场）。
7. **复用优先于加层**：能不新增抽象就不加，降复杂度（曾据此不拆多余的 mapper/类）。

---

## 三、分阶段演进

### P0 · 修复工具调用（实证定位根因）

- **误判排除**：先怀疑代理/模型，用 `debug-tool-call.cjs` 证明 `ChatOpenAICompletions + bindTools` 往返正常（`call_` id）；再用 `debug-agent.cjs` 证明 `createAgent + streamEvents({version:'v3'})` 才会出 `fc_` 并 400。
- **真因**：`streamEvents(v3)` 投影式流式在 OpenAI 兼容代理下让工具调用走 Responses 语义（`fc_` call_id），回填工具结果时匹配不上 → 400；工具体从未执行。
- **修法**：loop service 改用 `agent.stream({streamMode:'messages'})`，映射回 `message.delta / tool.call.*`。顺带简化（删 AsyncEventQueue 三路投影）。
- **插曲**：过程中发现"没生效"其实是**跑着旧代码的僵尸进程 + 另一个仓库(ai-lianlian)占了 :3000**——环境混淆，非代码问题。

### P1 · 统一执行链路

- Direct 也走 `createAgent`（tools 为空），与 ReAct 共用同一条执行 + 事件映射；删除脆弱字符串错误匹配与死代码。
- **思维**：消除双链路是"统一执行核心"原则的落地；`CommonChatAgentLoopService` 成为唯一 LangChain→StreamTask 映射器（没有为此新建冗余 mapper 类——避免加层）。

### P2 · 能力装配面

- 新增 `CapabilityRegistry`（tools/skills/subagents 闭集）+ `CapabilityResolver`（decision → 真实工具 + 技能提示词）。
- `toolGroups/skills` 从死字段变为真正驱动装配；路由工具可用性以注册表为准；移除无工具支撑的关键词。
- **思维**：把"能力"做成闭集单一事实源，根治"承诺不存在能力"。skills/subagents 先留接口不落实例（不为未来过度设计）。

### P3 · 做实 Plan/Hybrid + Controller

- 新增 `execution/`：`PlannerService`（Kimi 规划步骤）+ `AgentLoopController`（分步执行 + 观察收集 + 最终综合）+ `StepEvaluator`（启发式）。
- Plan=跑完所有步骤；Hybrid=每步后评估器判断"信息够了吗"提前收尾（用户原始诉求："收集够了就停，否则继续 loop"）。假 step 彻底消除；`maxSteps` 接线。
- **取舍**：evaluator 默认启发式（不额外调模型）；planner 用 Kimi 预设——顺带验证 LlmService 的"按请求切模型"热拔插设计好用。`kimi-for-coding` 只允许 `temperature=1`，故 planner 不覆盖 temperature。

### P4 · 结构化决策路由

- `StrategyRouter` 升级为 **LLM 结构化决策优先 + 关键词规则兜底**：Kimi 产出 `{mode,toolGroups,skills,maxSteps,confidence,reason}`，对 mode 别名归一、`toolGroups/skills` 收敛到闭集、区间夹紧。
- 开关 `LLM_ROUTER_ENABLED`（默认开）；失败即降级规则路由。
- **取舍**：每条消息多一次路由调用有延迟成本 → 提供关闭开关，快路径留作后续。

### 插曲 · Monorepo 化（见 [MONOREPO-MIGRATION.md](../../../MONOREPO-MIGRATION.md)）

- `backend/frontend` → `apps/{api,mobile}` + `packages/types` + pnpm workspace + turbo。
- 动机：多端 + **对齐前后端流式协议事件约定**（共享 `@litter-bear/types/protocol`）。
- 关键结论：先做 Taro spike 拆掉最大不确定性（Taro 吃 workspace 包）；共享包走 **ESM + `exports.default` 兜底**，Node ≥22.12 靠 `require(esm)` 让 Nest 也能消费。

### P5 · 人工审批（HITL）（见 [hitl.md](./hitl.md)）

- ReAct 工具级审批：受控工具执行前中断 → `approval.required` + 任务 `WAITING_HUMAN` → `POST /api/stream-tasks/:taskId/approval` 提交 approve/reject/edit → `Command` 从中断处续跑。
- 基于 LangChain `humanInTheLoopMiddleware` + LangGraph checkpointer（thread_id = taskId）。前端 `ApprovalCard` 组件 + 全链路接线。
- **取舍**：早期 Plan/Hybrid 审批(P5b)因 controller 在 langgraph 之外而延后；现已迁入 StateGraph。checkpointer 起初为进程内 `MemorySaver`，现已换成 `PostgresSaver`（独立 `langgraph` schema，复用 `DATABASE_URL`）。
- **实证**：`debug-hitl.cjs` 独立验证"中断 → getState 取 HITLRequest → Command 恢复 → 工具执行"机制成立。

### P5b/P5c · 策略图迁移与计划审批（2026-08-10）

- `AgentLoopController` 已删除，Plan/Hybrid 改由 `PlanGraphRunner` 构建原生 `StateGraph`。编排事件走 `stream({ streamMode: ['messages', 'custom'] })`，节点内必须使用 `config.writer()` 发 custom 事件；顶层 `writer()` 会静默失效。
- Plan/Hybrid 现与 ReAct 一样支持工具 HITL；`plan_execute` 还会在执行前触发计划审批。子图工具中断由外层 Postgres checkpointer 统一恢复，允许一次任务多轮进入 `WAITING_HUMAN`。
- 分步执行通过 state 通道下发步骤提示词与可见工具集；审批工具只有在 planner 对应步骤的 `suggestedTools` 明确标注时才会被隔离，防止生图、下单等副作用工具提前或重复执行。
- 完整图形状、实测约束与恢复语义见 [plan-graph-migration.md](./plan-graph-migration.md) 和 [hitl.md](./hitl.md)。

### P2-1 · 麦当劳 MCP 工具接入（2026-08-12）

- `McpClientManager` 是 MCP client、tools/list 缓存、审核白名单与健康快照的唯一所有者。对 Streamable HTTP，健康表示最近一次 tools/list 是否通过鉴权和 schema 校验，并非维持常驻 socket。麦当劳配置缺失或不完整时该 server 标记为不可用并跳过工具注册，不影响其他 API 模块启动；完整启用后的远端失败仍阻断启动。
- 启动时仅登记空的 `mcd-order` 工具组；它不加入 `default`。用户在登录后绑定自己的 MCP Token，系统以 `tools/list` 审核远端 8 个工具并加密保存凭据。聊天任务创建时锁定凭据 ID，路由、Agent 配置与能力解析仅在该任务具备活跃凭据时装配 MCP 工具；解绑、失效或 HITL 等待期换绑后均不会静默切换账号。
- `create-order` 是唯一 `requiresApproval` 工具：计划执行时先经过计划审批，再在真正创建订单前经过工具审批。`conversation_trace` 在工具调用与工具审批节点通过注册表元数据写入 `mcpServer=mcdonalds` 与 MCP 原始工具名。
- `strategy.selected` 持久化 `{ strategy, toolGroups, skills, maxSteps }` 到既有 `StreamTask.executionState`；HITL 恢复直接用该快照装配，保证 `mcd-order` 和 `create-order` 审批集不会在默认 agent 的计划审批后丢失。
- P2-1 本身不创建订单业务表；P2-2 已接管订单持久化与官方支付跳转。两阶段都不接微信支付。真实连通性可用 `node apps/api/scripts/debug-mcdonalds-mcp.cjs` 验证；该脚本只调用 tools/list。

### P2-2 · 订单持久化、回显与官方支付跳转（2026-08-13）

- `McDonaldsOrder` 是用户订单的唯一业务事实，`McDonaldsOrderRefresh` 只审计订单页显式触发的官方状态查询；两者都不替代或反向依赖 `conversation_trace`。`create-order` 包装工具从任务级 AsyncLocalStorage 上下文取得 `taskId/userId`，并按 `(userId, externalOrderId)` 幂等写入。
- `McpClientManager` 的职责没有扩张：它仍只负责 client、审核后的 tools/list 缓存、白名单与健康快照。订单服务按原工具名取得已审核工具，薄包装 `create-order` / `query-order`，保持 runtime name、schema、描述和 MCP 来源元数据不漂移。
- 工具完成后，`StreamTaskService` 从订单任务上下文读取本地 ID，发布只含安全卡片字段的 `order.created`；会话历史按 assistant `messageId` 从订单表回填。支付密文、支付 URL 和原始 MCP 结果不进入该事件、模型或 trace。
- `payH5Url` 在入库前从安全快照递归剥离，以 `MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY` AEAD 加密保存，最长保留 30 分钟。H5 在用户点击时即时解密并跳转官方 URL；小程序仅请求即时 PNG 二维码并写入临时文件。没有微信支付直连、自动轮询或支付 URL 的前端持久化。
- 订单刷新是受属主和全局 MCP token 属主双重校验的确定性 `query-order` 调用，不经过 Agent/LLM/HITL；成功更新订单快照和刷新审计，失败保留上次有效状态并抛出明确错误。

---

## 四、最终核心链路

```
POST /api/chat/message (@Sse)
 → StreamTaskService（建任务/落库/SSE/断线恢复；WAITING_HUMAN 生命周期）
   → CommonChatAgentRunnerService（上下文+提示词+模型；taskId→threadId）
     → AgentLoopRunner：StrategyRouter.route(LLM 决策) → CapabilityResolver.resolve
       → {Direct|ReAct|Plan|Hybrid}Graph（Plan/Hybrid 委托 PlanGraphRunner StateGraph）
         → CommonChatAgentService → CommonChatAgentLoopService
             createAgent(+checkpointer/+hitl middleware)
             stream({streamMode:'messages'}) → 映射 message.delta / tool.call.* / approval.required
             getState 检测中断；resume() 用 Command 续跑
           → LlmChatModelFactory（ChatOpenAICompletions / ChatAnthropic）→ 大模型
```

事件契约、逐层职责见 [agent-chat-chain.md](./agent-chat-chain.md)；HITL 细节见 [hitl.md](./hitl.md)；任务/SSE 见 [stream-task-architecture.md](./stream-task-architecture.md)。

---

## 五、TODO / 后续

**稳健性**

- [x] HITL checkpointer 持久化：`AgentCheckpointerService` 改用 `PostgresSaver`（`langgraph` schema），重启不再丢挂起状态；仅在 `DATABASE_URL` 缺失/`setup()` 失败时降级 MemorySaver 并 error 告警。
- [x] HITL 恢复重建：`strategy.selected` 已持久化首轮 `strategy/toolGroups/skills/maxSteps`，恢复按快照装配同一套能力。
- [ ] 多审批并发（一次多个工具调用 / 多消息挂起）目前是边界，未支持。

**能力**

- [x] P5b：Plan/Hybrid 中途审批 —— 已迁为 `StateGraph`，由外层 checkpointer 托管编排状态与子图中断恢复。
- [ ] 结构化路由快路径：明显直答的短消息跳过 LLM 路由，省一次调用延迟。
- [ ] skills / subagents 落实例（registry 已留接口）。
- [x] McDonalds MCP P2-1/P2-2：审核工具组、HITL、trace 来源、订单入库与刷新审计、`order.created`/历史回显以及官方支付跳转均已接入；不接微信支付。

**前端 / 工程**

- [ ] 真机 e2e：前端 + 登录 → 问"深圳天气" → 审批卡片 → 通过 → 续跑。
- [ ] `orval` 产物在出现第二个前端时提升为 `packages/api-client`，http mutator 做成可注入。
- [ ] 部署阶段：启用 `ci.yml` 触发器 + 部署脚本指向 `apps/api/dist/main`（现 CI 为手动占位模板）。
- [ ] 分支策略：`chore/monorepo` 现含 monorepo 迁移 + P0–P5 全部，何时/如何并入 main 待定。

---

## 六、关联文档

- [agent-chat-chain.md](./agent-chat-chain.md) — 逐层链路与事件契约
- [hitl.md](./hitl.md) — P5 人工审批细节
- [stream-task-architecture.md](./stream-task-architecture.md) — 任务/SSE/恢复
- [MONOREPO-MIGRATION.md](../../../MONOREPO-MIGRATION.md) — monorepo 迁移
- 诊断脚本：`scripts/debug-{tool-call,agent,hitl,planner,router,mcdonalds-mcp}.cjs`
