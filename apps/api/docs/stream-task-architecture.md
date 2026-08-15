# 流式任务架构

## 目标

将文本聊天的流式传输，从请求作用域实现迁移为任务作用域实现。

每个长时流都会成为一个 `StreamTask`，具备：

- 稳定的 `taskId`
- 持久化状态
- PostgreSQL 语义事件与会话 trace
- Redis Stream 帧缓冲
- 可恢复的 SSE 传输
- 兼容浏览器与微信小程序的恢复协议
- 首轮统一的语义化聊天入口

## 范围

这是一个单进程执行设计，提供持久化业务事实与可恢复 SSE 传输：

- `StreamTask`、`StreamTaskRun`、低频 `StreamTaskEvent` 与 `ConversationTurnTraceItem` 持久化在 PostgreSQL
- 每个 SSE 帧，包括 `message.delta`，都会写入带 TTL 的 Redis Stream，以支持短期回放
- 活跃 producer 的 AbortController 与本地订阅注册表保留在进程内存
- LangGraph HITL checkpoint 正常情况下持久化在 PostgreSQL；初始化失败时记录 error 日志并降级到进程内存，当前审批决定队列仍使用 Redis

这意味着：

- 正常网络断开可以恢复
- 已完成任务可以回放缓冲事件
- Node 进程重启后仍可以回放已缓冲事件
- 若 Node 进程在生成完成前重启，未完成的实时执行无法从精确 token 位置继续

## 当前文本聊天链路

当前文本聊天入口是：

- `POST /chat/message`

该端点直接返回 `text/event-stream`。

若请求未提供 `conversationId`，服务端会：

1. 创建新会话
2. 持久化用户消息
3. 持久化 assistant 占位消息
4. 持久化 `StreamTask`
5. 立即进入首轮 SSE 流

因此，首轮对外协议已收敛为一步：

1. 客户端调用 `POST /chat/message`
2. 服务端立即返回 SSE
3. 第一个事件是 `task.created`
4. 后续事件由底层可恢复任务管道产生

内部实现仍复用 `openTaskStream(...)`，从而使：

- 首轮请求
- 浏览器重连
- 小程序手动恢复

共享同一套回放与执行机制。

## 任务生命周期

状态：

- `PENDING`：任务已创建，尚未开始
- `STREAMING`：producer 正在运行
- `WAITING_HUMAN`：Agent 或计划 HITL 中断已持久化，等待人工决定；这是非终态
- `COMPLETED`：成功完成
- `ERROR`：执行失败
- `EXPIRED`：回放窗口已过期
- `CANCELED`：由客户端取消

说明：

- `PAUSED` 因历史原因仍保留在 Prisma 枚举中
- 当前实现不会主动写入 `PAUSED`
- 客户端断开不会将任务改为 `PAUSED`；任务会继续运行，或由客户端稍后从缓冲事件恢复

状态流转：

1. 客户端发送聊天消息
2. 服务端存储会话、消息、assistant 占位消息和 `StreamTask`
3. 服务端发送 `task.created`
4. 客户端立即进入 `/stream` 语义，或稍后恢复已有任务
5. 服务端回放 `lastEventId` 之后的缓冲事件
6. 服务端在需要时启动 producer
7. 服务端发送 `task.started`
8. 服务端发送零次或多次 `message.delta`
9. HITL 中断发送 `approval.required` 或 `plan.review.required`，创建运行中的审批 trace，并将任务投影为 `WAITING_HUMAN`；审批端点恢复同一任务，任务也可能再次进入等待
10. 服务端发送终态事件并写入最终任务状态

典型路径：

- 成功：`PENDING -> STREAMING -> COMPLETED`
- 审批：`STREAMING -> WAITING_HUMAN -> STREAMING`（零轮或多轮）
- 供应商错误：`PENDING/STREAMING -> ERROR`
- 客户端取消：`PENDING/STREAMING/WAITING_HUMAN -> CANCELED`
- 回放窗口超时：`PENDING/STREAMING -> EXPIRED`

## 客户端协议

### 浏览器

首轮：

1. 调用 `POST /chat/message`
2. 解析首个 `task.created` 事件
3. 保存 `taskId`、`conversationId`、`messageId`
4. 继续消费同一条 SSE 连接

重连：

1. 使用 `GET /stream-tasks/:taskId/stream`
2. 浏览器可以携带 `Last-Event-ID` 或 `cursor` 查询参数重连

### 微信小程序

首轮：

1. 调用 `POST /chat/message`
2. 解析首个 `task.created` 事件
3. 持久化 `taskId` 与 `lastEventId`

恢复：

1. 使用 `POST /stream-tasks/:taskId/resume`
2. 在请求体中发送 `lastEventId`
3. 手动解析 SSE 分块，并持续持久化 `lastEventId`

对于 `POST /stream-tasks/:taskId/resume`，服务端接受以下游标来源：

- 请求体 `lastEventId`
- 请求头 `Last-Event-ID`

优先级：

1. 请求体
2. 请求头

对于 `GET /stream-tasks/:taskId/stream`，服务端接受 `cursor` 查询参数或 `Last-Event-ID` 请求头，且请求头优先。

## 存储

### PostgreSQL

`StreamTask` 保存：

- 任务身份与归属
- 任务类型
- 当前状态
- 原始请求载荷
- 关联会话与消息
- 最近发出的事件 ID
- 累积内容
- 错误与过期元数据

`StreamTaskRun` 记录每段客户端可见的执行。`StreamTaskEvent` 记录低频语义事件，例如任务生命周期、路由、工作流步骤、模型/工具生命周期、审批和订单。`ConversationTurnTraceItem` 将选定的语义事件归约为历史消息中可见的 trace 节点。

语义事件路径是同步且有序的，但不是单一数据库事务：先更新 `StreamTask`，再创建 `StreamTaskEvent`，然后向 Redis 写入 SSE 帧。trace 归约发生在该事件之后；若失败只记录 warning，不阻断聊天链路。

`message.delta` 被刻意排除在 `StreamTaskEvent` 之外。producer 在内存中将其拼接为 `fullContent`，定期将累积文本刷入 `StreamTask`；运行结束或进入 `WAITING_HUMAN` 时一定写入最终内容。

### Redis

- `{STREAM_TASK_FRAME_KEY_PREFIX}:{taskId}`：序列化 SSE 帧组成的 Redis Stream，受长度和 TTL 限制；其 Redis Stream ID 是客户端回放游标
- `stream-task:lock:{taskId}`：producer 锁
- `hitl:approval:{taskId}` / `hitl:plan-review:{taskId}`：当前审批决定队列，由进程内续跑路径消费一次，并随任务帧缓冲窗口过期

## API

### 发送文本消息并立即启动 SSE

`POST /chat/message`

请求：

```json
{
  "conversationId": "conv_xxx",
  "content": "你好"
}
```

若省略 `conversationId`，服务端会在同一请求路径中创建新会话。

该端点返回 `text/event-stream`，而不是普通 JSON 响应体。

### 历史兼容入口

以下端点可能仍会作为临时兼容壳存在：

- `POST /chat/completions`
- `POST /chat/messages`

它们会创建任务，但已不再是推荐的首轮文本聊天协议。

### 创建语音任务

`POST /chat/voice-messages`

Whisper 转写完成后返回相同的任务载荷。

### 查询任务

`GET /stream-tasks/:taskId`

返回状态、`lastEventId`、`fullContent` 以及是否仍可恢复。

### 浏览器流

`GET /stream-tasks/:taskId/stream?cursor=12`

### 小程序恢复

`POST /stream-tasks/:taskId/resume`

请求体：

```json
{
  "lastEventId": 12
}
```

### 取消任务

`POST /stream-tasks/:taskId/cancel`

### 工具审批与计划审核

- `POST /stream-tasks/:taskId/approval`：提交工具审批的 `approve` / `reject` / `edit`，并返回恢复后的 SSE 流。
- `POST /stream-tasks/:taskId/plan-review`：提交计划审核的 `approve` / `edit` / `reject_replan` / `reject_terminate`，并返回恢复后的 SSE 流。

## 事件类型

唯一契约来源是 `@litter-bear/types/protocol`（`StreamTaskEventType` 与载荷类型）。当前事件集合包括：

- 路由与 Agent 执行：`agent.routed`、`agent.loop.start`、`strategy.selected`、`skill.selected`
- 编排与模型/工具生命周期：`workflow.step.*`、`model.call.*`、`tool.call.*`、`order.created`
- HITL：`approval.required|resolved`、`plan.review.required|resolved`
- 消息与任务生命周期：`message.*`、`task.*`、`conversation.title.updated`

## 事件载荷格式

SSE 传输遵循标准格式：

```text
id: 1768600000000-0
event: message.delta
data: {"type":"message.delta","taskId":"task_xxx", ...}

```

所有任务相关 SSE 的 `data` 载荷均使用统一 JSON 包络：

```json
{
  "type": "message.delta",
  "taskId": "task_xxx",
  "streamId": "run_xxx",
  "conversationId": "conv_xxx",
  "messageId": "msg_xxx",
  "status": "streaming",
  "payload": {
    "delta": "你好"
  },
  "errorMessage": null
}
```

字段语义：

- `type`：业务事件类型，通常与 SSE `event` 相同
- `taskId`：稳定的任务身份
- `streamId`：可选的客户端可见执行片段身份（`StreamTaskRun`）
- `conversationId`：本轮对应的会话身份
- `messageId`：assistant 消息身份
- `status`：小写形式的最新任务状态
- `payload`：事件特定的业务数据
- `errorMessage`：仅错误事件填充

当前事件特定载荷约定：

- `task.created`：没有 `payload`；顶层字段携带任务身份
- `task.started`：没有 `payload`
- `message.delta`：`payload.delta`
- `message.done`：`payload.content`
- `task.completed`：没有 `payload`
- `task.error`：顶层 `errorMessage`（面向用户的文案）；`payload` 为结构化错误 `{ category, retryable, status? }`，`category` 取自共享协议 `TaskErrorCategory`（rate_limit / auth / timeout / network / invalid / server / unknown）。`StreamTask.errorMessage` 仅保留文本；完整低频事件载荷保存在 `StreamTaskEvent`。
- `task.expired`：没有 `payload`
- `task.canceled`：没有 `payload`

## 实现说明

- `chat/message` 是首轮文本聊天的语义化入口
- `chat` 拥有业务入口，但不拥有回放机制
- `stream-task` 负责回放、实时订阅、状态查询和取消
- `SseInterceptor` 已收敛为只负责传输写入
- 低频语义事件序列 ID 在写入 `StreamTaskEvent` 前分配；Redis Stream 帧 ID 始终是 SSE 回放游标
- 任务创建与任务执行相互分离
- 首轮与恢复路径共用同一条 `StreamTask` 执行管道
- 模型选择参数持久化在任务载荷中，以保证恢复时使用相同 LLM 配置
- HITL trace 与任务状态持久化在 PostgreSQL，而当前人工决定是 Redis TTL 值；这是已知的交接边界，并非持久化工作流引擎

## 已知限制

此版本支持 SSE 传输恢复，但在进程重启后不支持供应商侧 token 生成的完整恢复。只要 Redis 中的审批决定仍可用，HITL 可以从 PostgreSQL LangGraph checkpoint 恢复；已过期或丢失的待消费决定无法仅凭 `WAITING_HUMAN` 重建。Temporal 迁移会以持久化数据库决定和 Workflow Signal 替代这一决定交接方式。
