# HITL（人工审批）— P5

> 工具级人工审批：模型在执行受控工具前暂停，等待人工 approve / reject / edit，再从中断处续跑。
> 基于 LangChain v1 `humanInTheLoopMiddleware` + LangGraph `checkpointer` + `Command` 恢复。
> 相关链路见 [agent-chat-chain.md](./agent-chat-chain.md)、[stream-task-architecture.md](./stream-task-architecture.md)。

## 范围

- **P5a（已实现）**：**ReAct** 策略的工具级审批。Direct 无工具不涉及。
- **P5b（延后）**：Plan/Hybrid 的中途审批。其 controller 是手写 JS 编排，状态不在 LangGraph 图内，checkpointer 托管不到；需先把 controller 迁成 StateGraph，届时再开。

## 端到端流程

跨两个 HTTP 请求：首轮流（暂停）+ 审批端点（恢复）。

```
① POST /api/chat/message ─► StreamTask(STREAMING)
   runChatTask → prepareConversationRun(taskId 作为 thread_id)
     → ReAct: createAgent({ checkpointer, middleware:[hitl] })
        agent.stream(input, { streamMode:'messages', configurable:{ thread_id: taskId } })
     → 模型提议 getWeather（已配 requiresApproval）→ hitl 中间件在工具执行前 interrupt()
   loop 结束 → getState 检测挂起中断 → 发 approval.required 事件
   runChatTask 检测到 pendingApproval → 任务置 WAITING_HUMAN，不落 message.done / COMPLETED
   （检查点已持久化，图暂停；SSE 首轮流结束）

② 前端收到 approval.required → 展示 通过/拒绝/改参 卡片

③ POST /api/stream-tasks/:taskId/approval  { decision, editedArgs?, reason?, lastEventId? }
   resumeTaskWithDecision：校验 WAITING_HUMAN + 归属 → 决定写入 Redis(hitl:approval:<taskId>)
     → 复用 createTaskStream → ensureTaskExecution → runTask → runChatTask
   runChatTask 读到待处理决定 → 走 resumeConversationRun：
     同 thread_id + 全量 tools + 审批策略重建 agent
     → agent.stream(new Command({ resume: HITLResponse }), config)
       approve → 执行工具 / reject → 回注拒绝 / edit → 用改后入参执行
   续跑 → message.delta … → COMPLETED（或再次中断 → 再 WAITING_HUMAN）
```

关键：**同一 `checkpointer`（进程单例）+ 稳定 `thread_id`（= taskId）**。重建 agent 对象无所谓，图状态从 checkpointer 按 thread_id 取回。

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

> **P5a 演示**：临时给只读的 `getWeather` 开了审批，使"深圳天气"即可端到端验证。真实策略应按语义配置（只读免审批、写类/高风险需审批）。

## 关键实现点

- **中断检测**：不解析消息流。首轮流结束后 `agent.getState({configurable:{thread_id}})`，`state.tasks[].interrupts[].value` 即 `HITLRequest`：
  `{ actionRequests:[{name,args,description?}], reviewConfigs:[{actionName,allowedDecisions}] }` → 映射为 `approval.required`。
- **恢复**：`agent.stream(new Command({ resume: { decisions: [...] } }), config)`。每个 actionRequest 对应一个 decision。
- **thread_id = taskId**：初始运行与恢复共享。
- **任务状态**：`StreamTaskStatus.WAITING_HUMAN`（数据库枚举已预留，非终态；`isTerminalStatus` 不含它，故恢复能顺利触发执行）。
- **决定传递**：审批端点把决定写 Redis `hitl:approval:<taskId>`（TTL=缓冲期），后台 `runChatTask` 读取一次即消费，据此选 resume 路径。

## 恢复的重建策略与边界

恢复不重新路由/决策，直接重建 agent：
- `tools` = `registry.listTools()`（全量，确保挂起工具在场，ToolNode 按名匹配）。
- `systemPrompt` = 基础提示词。
- `approvalToolNames` = `registry.listApprovalToolNames()`。

对 P5a（单工具 getWeather、无 skill）与首轮完全一致。**将来多工具组/skill 场景需持久化首轮的 decision/toolGroups 才严谨**，否则重建的工具集/提示词可能与首轮不一致。

其它边界：
- **MemorySaver 进程内**：服务重启会丢挂起状态。生产应换成基于现有 Redis 的 `BaseCheckpointSaver`——已封装 `AgentCheckpointerService`，替换只改这一处。
- **中断前的助手文本**：若模型在工具调用前输出过文本，暂停时未并入最终 message，恢复后的 message 只含续跑文本（P5a 常见流程是先调工具，无此问题）。
- **approval.required 无 toolCallId**：`HITLRequest.actionRequests` 不带工具调用 id，前端按 toolName + 最近的 tool.call.* 关联即可。

## 涉及文件

| 层 | 文件 |
|---|---|
| 协议 | `packages/types/src/protocol/index.ts` |
| 能力 | `agent-loop/capability/capability.{registry,resolver,types}.ts` |
| checkpointer | `agents/common-chat-agent/agent-checkpointer.service.ts` |
| agent 层 | `agents/common-chat-agent/common-chat-agent-{factory,loop,service,runner}.service.ts` + `*.types.ts` |
| 透传 | `agent-loop/{agent-loop.types,agent-loop-runner}.ts`、`graphs/common-react.graph.ts` |
| 任务/端点 | `stream-task/stream-task.{service,controller}.ts`、`dto/submit-approval.dto.ts` |
| 诊断 | `scripts/debug-hitl.cjs` |

## 验证

`node scripts/debug-hitl.cjs`（真实模型，独立于 HTTP）已验证核心机制：
- turn1：工具**未执行**（工具执行前中断）；
- `getState` 读出 `actionRequests`/`reviewConfigs`（结构与解析一致）；
- `Command({resume:{decisions:[{type:'approve'}]}})` 续跑 → **工具执行** → 最终答案。

配合 `pnpm build` + `lint` 全绿、api 启动 DI 装配正常。

端到端（前端 + 登录态）验证与前端审批卡片为收尾项。
