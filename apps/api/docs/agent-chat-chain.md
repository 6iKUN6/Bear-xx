# 聊天 Agent 调用链路

> 从 `POST /api/chat/message` 到大模型的完整链路说明。请求**向下**穿透到大模型；token / 工具 / 状态事件**向上**冒泡为 SSE 推给前端。

## 总览

```
POST /api/chat/message  (@Sse, JWT, 限流 10/min)                 chat.controller.ts
  └─ ChatService.streamMessage                                    (纯转发)
     └─ StreamTaskService
         ├─ streamChatTask   建/复用会话 → 落库用户消息 + assistant 占位(pendingMessageId)
         │                   → 建 StreamTask 记录 → 返回 SSE observable
         └─ executeChatTask  for await (agentRun.events) → 按类型泵成 SSE + 落库
             └─ CommonChatAgentRunnerService.prepareConversationRun
                 ├─ ChatContextService.buildContextBundle   会话摘要 + 最近窗口
                 ├─ resolveSystemPrompt()                   chatAgentCommonPrompt
                 ├─ resolveTextRequest(llm)                 解析模型预设
                 ├─ tools = capabilityRegistry.listTools()  仅供 trace 日志
                 └─ AgentLoopRunnerService.stream(...)   ← 返回事件流
                     ├─ StrategyRouter.route()               规则路由选 mode
                     ├─ CapabilityResolver.resolve(decision) 按 toolGroups/skills 装配真实工具+提示词
                     ├─ emit strategy.selected / skill.selected
                     ├─ executionInput = { ...input, tools, maxSteps, systemPrompt(合并技能) }
                     └─ StrategyRegistry.resolve(mode).stream(executionInput)
                         ├ Direct → CommonChatAgentService.streamEvents(tools:[]) + ModelCall* 书签
                         ├ ReAct  → CommonChatAgentService.streamEvents(tools)   + AgentLoopStart 书签
                         ├ Plan   → AgentLoopController.stream(input, PlanExecute)   静态
                         └ Hybrid → AgentLoopController.stream(input, Hybrid)        动态
                             └─ CommonChatAgentService.streamEvents → createEventStream
                                 ├─ llmService.createChatModel()  ← LlmChatModelFactory
                                 │      openai → ChatOpenAICompletions / anthropic → ChatAnthropic
                                 └─ CommonChatAgentLoopService.stream
                                     ├─ agentFactory.createAgent({model,systemPrompt,tools})
                                     ├─ agent.stream({messages},{streamMode:'messages'})
                                     └─ 映射: ai.text→MessageDelta / tool_call_chunks→ToolCall* / ToolMessage→Done|Error
                                         └─ 大模型 /chat/completions (经代理) → gpt-5.5
```

## 分层职责

| 层 | 文件 | 职责 |
|---|---|---|
| HTTP 入口 | `chat/chat.controller.ts` | `@Sse()` 建立 text/event-stream；鉴权、限流；`req.__sseAbortSignal` 断线中断 |
| 业务转发 | `chat/chat.service.ts` | 转发到 StreamTask |
| 任务/推流 | `stream-task/stream-task.service.ts` | **唯一**处理任务、落库、SSE、断线恢复（`:taskId/resume`、`:taskId/cancel`）；消费 agent 事件流泵成 SSE |
| 运行组装 | `ai/agents/common-chat-agent/common-chat-agent-runner.service.ts` | 组装上下文 + 系统提示词 + 模型请求，交给 agent-loop |
| 决策+装配 | `ai/agent-loop/agent-loop-runner.service.ts` | 路由选 mode → 解析能力 → 注入真实 tools/maxSteps/提示词 → 选策略图 |
| 能力面 | `ai/agent-loop/capability/*` | Registry（闭集：tools/skills/subagents）+ Resolver（decision → 真实装配） |
| 策略图 | `ai/agent-loop/graphs/*` | Direct / ReAct / Plan / Hybrid 四种编排 |
| 监督循环 | `ai/agent-loop/execution/*` | Plan/Hybrid 的 planner + controller + 评估器 |
| 事件映射 | `ai/agents/common-chat-agent/common-chat-agent-loop.service.ts` | **唯一** LangChain→StreamTask 事件映射器（四种模式共用） |
| Provider | `ai/../llm/providers/chat-model.factory.ts` | provider 收敛，业务层不碰具体 SDK |

## 策略模式

路由由 `StrategyRouterService` 决定，四种。默认走**结构化 LLM 决策**（Kimi，输出约束在能力注册表闭集内）；模型失败/输出非法/`LLM_ROUTER_ENABLED=false` 时降级为关键词规则：

- **Direct**：无工具，直接生成。走统一 executor（`createAgent`，tools 为空）。
- **ReAct**：带工具，模型按需调用。走统一 executor。
- **Plan（静态）**：`AgentLoopController` 先用 **Kimi** 规划出步骤（真实 step 事件）→ 逐步执行（每步一次 ReAct，转发工具事件、收集文本为观察，不直接作为答案）→ 跑完所有步骤 → 最后一次不带工具的**综合调用**流式输出最终答案。
- **Hybrid（动态）**：同 Plan，但每步后用 `StepEvaluator`（默认启发式）判断"信息是否足够"以**提前收尾**（"收集够了就停，否则继续 loop"）。

`maxSteps`（决策给出，默认 6）作为步骤/迭代预算上限。

## SSE 事件类型

见 `stream-task/stream-task-event.types.ts`。关键：
- `strategy.selected` / `skill.selected` — 决策与能力
- `agent.loop.start` / `workflow.step.start|done` — 编排进度
- `model.call.start|done` — 模型调用书签
- `tool.call.start|delta|done|error` — 工具调用生命周期
- `message.delta` / `message.done` — 助手文本
- `approval.required` — 工具执行前需人工审批（HITL，见下）
- `task.created|started|completed|error|expired|canceled` — 任务终态

## 关键设计说明

### 为什么用 `stream({streamMode:'messages'})` 而非 `streamEvents({version:'v3'})`
`streamEvents(v3)` 的投影式流式在部分 OpenAI 兼容代理下，会让工具调用走 Responses 语义（`fc_` 前缀 call_id），导致回填工具结果时 `400 No tool call found for function call output`。`stream({streamMode:'messages'})` 走普通 Chat Completions 流式，工具调用 id 正常（`call_`），工具正常执行，且保留 token 级增量。

### 能力装配（消除死字段）
`decision.toolGroups / skills / maxSteps` 不再是装饰：`CapabilityResolver` 依据决策从 `CapabilityRegistry` 闭集解析出真实工具与技能提示词，注入执行输入。路由只能选注册表里已存在的能力，避免"承诺了没有的能力"。

### 结构化路由（决策 agent）
`StrategyRouterService.route` 默认用 Kimi 做一次结构化决策，产出 `{mode, toolGroups, skills, maxSteps, confidence, reason}`，并对 `mode` 做别名归一、`toolGroups/skills` 收敛到注册表闭集、`maxSteps/confidence` 做区间约束；非 direct 模式在缺省工具组时兜底 `default`。任何失败降级为关键词规则路由。可用 `LLM_ROUTER_ENABLED=false` 关闭（回到纯规则），以规避每条消息多一次路由调用的延迟。

### Planner 的模型选择
Planner 通过 `{ model: { platform: 'kimi' } }` 选中 Kimi 预设（依赖 `KIMI_API_KEY`）。注意：`kimi-for-coding` 端点仅允许 `temperature=1`，故 planner **不覆盖 temperature**。任何规划失败都回退为"单步=原始请求"，不影响主链路。

### HITL（工具级人工审批）
ReAct 命中配置了 `requiresApproval` 的工具时，agent 在工具执行前中断，发 `approval.required` 并把任务置 `WAITING_HUMAN`；人工经 `POST /api/stream-tasks/:taskId/approval` 提交 approve/reject/edit 后用 `Command` 从中断处续跑。基于 LangGraph checkpointer（thread_id = taskId）。详见 [hitl.md](./hitl.md)。
