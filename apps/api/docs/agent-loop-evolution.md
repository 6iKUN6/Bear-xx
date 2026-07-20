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
- **取舍**：checkpointer 先用进程内 `MemorySaver`（封装成 service 便于换 Redis）；Plan/Hybrid 审批(P5b)延后（controller 在 langgraph 之外，需迁 StateGraph）。
- **实证**：`debug-hitl.cjs` 独立验证"中断 → getState 取 HITLRequest → Command 恢复 → 工具执行"机制成立。

---

## 四、最终核心链路

```
POST /api/chat/message (@Sse)
 → StreamTaskService（建任务/落库/SSE/断线恢复；WAITING_HUMAN 生命周期）
   → CommonChatAgentRunnerService（上下文+提示词+模型；taskId→threadId）
     → AgentLoopRunner：StrategyRouter.route(LLM 决策) → CapabilityResolver.resolve
       → {Direct|ReAct|Plan|Hybrid}Graph（Plan/Hybrid 委托 AgentLoopController）
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
- [ ] HITL checkpointer 换成基于 Redis 的 `BaseCheckpointSaver`（现 MemorySaver 进程内，重启丢挂起状态）。仅需改 `AgentCheckpointerService`。
- [ ] HITL 恢复重建：持久化首轮 `decision/toolGroups`（现恢复用全量 tools + 基础 systemPrompt，仅对单工具/无 skill 严格一致）。
- [ ] 多审批并发（一次多个工具调用 / 多消息挂起）目前是边界，未支持。

**能力**
- [ ] P5b：Plan/Hybrid 中途审批 —— 需把 `AgentLoopController` 迁成 langgraph `StateGraph`，让 checkpointer 托管编排状态（顺带让长多步任务可中断恢复）。
- [ ] 结构化路由快路径：明显直答的短消息跳过 LLM 路由，省一次调用延迟。
- [ ] skills / subagents 落实例（registry 已留接口）。
- [ ] McDonalds MCP 接入（现仅保留目录）。

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
- 诊断脚本：`scripts/debug-{tool-call,agent,hitl,planner,router}.cjs`
