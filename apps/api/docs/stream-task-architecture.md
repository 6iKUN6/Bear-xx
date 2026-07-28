# Stream Task Architecture

## Goal

Move text chat streaming delivery from a request-scoped implementation to a task-scoped implementation.

Each long-running stream becomes a `StreamTask` with:

- stable `taskId`
- persistent status
- Redis event buffer
- resumable SSE delivery
- browser and WeChat Mini Program compatible resume protocol
- a single semantic chat entrypoint for the first round

## Scope

This first implementation is a single-process resumable design:

- task state persists in PostgreSQL
- event buffer persists in Redis
- live publishers/subscribers live in process memory

That means:

- normal network disconnects can resume
- completed tasks can replay buffered events
- if the Node process restarts, buffered events can still replay
- if the Node process restarts before generation completes, unfinished live execution cannot continue from the exact token position

## Current Text Chat Flow

The current text chat entrypoint is:

- `POST /chat/message`

This endpoint directly returns `text/event-stream`.

If the request does not provide `conversationId`, the server will:

1. create a new conversation
2. persist the user message
3. persist an assistant placeholder message
4. persist the `StreamTask`
5. immediately enter the first SSE stream

That means the external protocol is now one-step for the first round:

1. client calls `POST /chat/message`
2. server returns SSE immediately
3. first event is `task.created`
4. subsequent events are produced by the underlying resumable task pipeline

The internal implementation still reuses `openTaskStream(...)` so that:

- the first round
- browser reconnect
- Mini Program manual resume

all share the same replay and execution mechanism.

## Task Lifecycle

Statuses:

- `PENDING`: task created, not started yet
- `STREAMING`: producer is running
- `COMPLETED`: finished successfully
- `ERROR`: failed
- `EXPIRED`: replay window expired
- `CANCELED`: canceled by client

Notes:

- `PAUSED` still exists in the Prisma enum for historical reasons
- the current implementation does not actively write `PAUSED`
- client disconnect does not change task status to `PAUSED`; the task either keeps running, or the client resumes later from buffered events

State transitions:

1. client sends a chat message
2. server stores conversation, message, assistant placeholder, and `StreamTask`
3. server emits `task.created`
4. client enters `/stream` semantics immediately, or resumes an existing task later
5. server replays buffered events after `lastEventId`
6. server starts producer if needed
7. server emits `task.started`
8. server emits `message.delta` zero or more times
9. server emits terminal events and writes final task status

Typical terminal paths:

- success: `PENDING -> STREAMING -> COMPLETED`
- provider error: `PENDING/STREAMING -> ERROR`
- client cancel: `PENDING/STREAMING -> CANCELED`
- replay window timeout: `PENDING/STREAMING -> EXPIRED`

## Client Protocol

### Browser

First round:

1. call `POST /chat/message`
2. parse the first `task.created` event
3. store `taskId`, `conversationId`, `messageId`
4. continue consuming the same SSE connection

Reconnect:

1. use `GET /stream-tasks/:taskId/stream`
2. browser can reconnect with `Last-Event-ID` or `cursor` query

### WeChat Mini Program

First round:

1. call `POST /chat/message`
2. parse the first `task.created` event
3. persist `taskId` and `lastEventId`

Resume:

1. use `POST /stream-tasks/:taskId/resume`
2. send `lastEventId` in request body
3. manually parse SSE chunks and keep persisting `lastEventId`

The server accepts resume cursors from:

- request body `lastEventId`
- query `cursor`
- header `Last-Event-ID`

Priority:

1. body
2. query
3. header

## Storage

### PostgreSQL

`StreamTask` stores:

- task identity and ownership
- task type
- current status
- original payload
- associated conversation and message
- last emitted event id
- accumulated content
- error and expiration metadata

### Redis

- `stream-task:buffer:{taskId}`: ZSET of serialized SSE events
- `stream-task:lock:{taskId}`: producer lock

## API

### Send text message and start SSE immediately

`POST /chat/message`

Request:

```json
{
  "conversationId": "conv_xxx",
  "content": "你好"
}
```

If `conversationId` is omitted, the server creates a new conversation in the same request path.

This endpoint returns `text/event-stream`, not a normal JSON response body.

### Legacy compatibility entrypoints

The following endpoints may still exist temporarily as compatibility shells:

- `POST /chat/completions`
- `POST /chat/messages`

They create tasks, but they are no longer the recommended first-round text chat protocol.

### Create voice task

`POST /chat/voice-messages`

Returns the same task payload after Whisper transcription completes.

### Query task

`GET /stream-tasks/:taskId`

Returns status, `lastEventId`, `fullContent`, and whether resume is still possible.

### Browser stream

`GET /stream-tasks/:taskId/stream?cursor=12`

### Mini Program resume

`POST /stream-tasks/:taskId/resume`

Body:

```json
{
  "lastEventId": 12
}
```

### Cancel task

`POST /stream-tasks/:taskId/cancel`

## Event Types

- `task.created`
- `task.started`
- `message.delta`
- `message.done`
- `task.completed`
- `task.error`
- `task.expired`
- `task.canceled`

## Event Payload Format

SSE transport is standard:

```text
id: 1
event: message.delta
data: {"type":"message.delta", ...}

```

All task-related SSE `data` payloads now use one unified JSON envelope:

```json
{
  "type": "message.delta",
  "taskId": "task_xxx",
  "conversationId": "conv_xxx",
  "messageId": "msg_xxx",
  "status": "streaming",
  "payload": {
    "delta": "你好"
  },
  "errorMessage": null
}
```

Field semantics:

- `type`: business event type, normally equal to the SSE `event`
- `taskId`: stable task identity
- `conversationId`: conversation identity for this round
- `messageId`: assistant message identity
- `status`: latest task status in lowercase form
- `payload`: event-specific business data
- `errorMessage`: only populated for error events

Current event-specific payload conventions:

- `task.created`: no `payload`; top-level fields carry task identity
- `task.started`: no `payload`
- `message.delta`: `payload.delta`
- `message.done`: `payload.content`
- `task.completed`: no `payload`
- `task.error`: top-level `errorMessage`（面向用户的文案）；`payload` 为结构化错误 `{ category, retryable, status? }`，`category` 取自共享协议 `TaskErrorCategory`（rate_limit / auth / timeout / network / invalid / server / unknown），供前端按类别展示文案与是否提供「重试」。DB 仍只持久化 `errorMessage` 字符串，错误类别只随事件下发，不入 `stream_tasks` 表
- `task.expired`: no `payload`
- `task.canceled`: no `payload`

## Implementation Notes

- `chat/message` is the semantic first-round text chat entrypoint
- `chat` owns the business entrypoint, but not the replay mechanism
- `stream-task` owns replay, live subscribe, status query, and cancel
- `SseInterceptor` is reduced to transport writing only
- event ids are assigned before buffering so replayed events keep stable ids
- task creation and task execution are separated
- the first round and resume path share the same `StreamTask` execution pipeline
- model selection parameters are persisted in task payload so resume uses the same LLM config

## Known Limitation

This version is resumable for SSE delivery, not fully resumable for provider-side token generation after process restart.
