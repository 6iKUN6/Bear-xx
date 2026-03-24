# SSE Task Architecture

## Goal

Move SSE from a request-scoped implementation to a task-scoped implementation.

Each long-running stream becomes an `SseTask` with:

- stable `taskId`
- persistent status
- Redis event buffer
- resumable SSE delivery
- browser and WeChat Mini Program compatible resume protocol

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

## Task Lifecycle

Statuses:

- `PENDING`: task created, not started yet
- `STREAMING`: producer is running
- `PAUSED`: client disconnected, task may still be running or waiting to be resumed
- `COMPLETED`: finished successfully
- `ERROR`: failed
- `EXPIRED`: replay window expired
- `CANCELED`: canceled by client

State transitions:

1. client creates task
2. server stores `SseTask`
3. client opens `/stream` or `/resume`
4. server starts producer if needed
5. server replays buffered events after `lastEventId`
6. server attaches the client to the live publisher
7. server marks final status when done/error/canceled

## Client Protocol

### Browser

1. `POST /chat/completions` to create a chat task
2. get `taskId`
3. use `GET /sse-tasks/:taskId/stream`
4. browser can reconnect with `Last-Event-ID` or `cursor` query

### WeChat Mini Program

1. `POST /chat/completions` to create a chat task
2. get `taskId`
3. use `POST /sse-tasks/:taskId/resume`
4. send `lastEventId` in request body
5. manually parse SSE chunks and persist `lastEventId`

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

`SseTask` stores:

- task identity and ownership
- task type
- current status
- original payload
- associated conversation and message
- last emitted event id
- accumulated content
- error and expiration metadata

### Redis

- `sse:buffer:{taskId}`: ZSET of serialized SSE events
- `sse:lock:{taskId}`: producer lock

## API

### Create chat task

`POST /chat/completions`

Response:

```json
{
  "taskId": "task_xxx",
  "messageId": "msg_xxx",
  "status": "pending"
}
```

### Create voice task

`POST /chat/voice-completions`

Returns the same task payload after Whisper transcription completes.

### Query task

`GET /sse-tasks/:taskId`

Returns status, `lastEventId`, `fullContent`, and whether resume is still possible.

### Browser stream

`GET /sse-tasks/:taskId/stream?cursor=12`

### Mini Program resume

`POST /sse-tasks/:taskId/resume`

Body:

```json
{
  "lastEventId": 12
}
```

### Cancel task

`POST /sse-tasks/:taskId/cancel`

## Event Types

- `task.started`
- `message.delta`
- `message.done`
- `task.completed`
- `task.error`
- `task.expired`
- `task.canceled`

## Implementation Notes

- `chat` creates tasks, but does not own SSE transport anymore
- `sse-task` owns replay, live subscribe, status query, and cancel
- `SseInterceptor` is reduced to transport writing only
- event ids are assigned before buffering so replayed events keep stable ids
- task creation and task execution are separated

## Known Limitation

This version is resumable for SSE delivery, not fully resumable for provider-side token generation after process restart.
