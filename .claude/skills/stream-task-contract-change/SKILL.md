---
name: stream-task-contract-change
description: Use when adding or changing a Litter-Bear StreamTask SSE event, event payload, task lifecycle state, replay behavior, or the mobile consumer of streamed agent output.
---

# 演进流式任务契约

## Overview

`packages/types/src/protocol` 是流式事件的唯一契约源。一次事件变更必须让产生、持久化/回放、前端消费和展示语义同时成立，不能靠前端字符串或多字段兼容掩盖漂移。

## 变更流程

1. 阅读 `apps/api/docs/stream-task-architecture.md`、`agent-chat-chain.md`、`packages/types/src/protocol`、`stream-task.service.ts` 与 mobile 的 `services/stream`。
2. 判定变更类型：执行进度事件、工具生命周期事件、任务终态、审批事件，或仅 trace 条目。不要把高频 `message.delta` 误做成持久 trace。
3. 先在共享协议定义事件枚举、结构化 payload、中文标签和终态集合；新增字段要强类型化，避免继续扩张 `Record<string, unknown>`。
4. 将事件从统一 agent 映射器经 `StreamTaskService` 发射。确认事件 ID、Redis 缓冲、断线回放和任务状态语义仍正确。
5. 在 mobile 通过 `StreamTaskEventType` 消费，补状态/反馈/UI 分支。REST DTO 变更后更新 Swagger 源并在 `apps/mobile` 运行 `pnpm generate:api:local`；不得手改 OpenAPI 导出或 `src/api/generated`。

## 不变量

| 不变量 | 含义 |
| --- | --- |
| 稳定任务身份 | 同一任务使用稳定 `taskId` 与递增事件游标 |
| 终态一致 | 终态事件、数据库 status、前端停止消费保持一致 |
| 失败可见 | 接口、权限、配置和工具失败进入 error state，不伪装为空或成功 |
| 无兼容旁路 | 契约变更同步所有消费者，不并存 `items/list` 或多套 payload |

## 验证

执行 `pnpm --filter @litter-bear/types run build`、`pnpm --filter ./apps/api run build` 和 `pnpm --filter ./apps/mobile run typecheck`；改动小程序流式 UI 时补 `build:weapp`。用首轮、断线后 resume、终态回放和失败路径检查新事件的顺序、payload 与展示；若进入 trace，验证刷新后可回溯。

## 常见误区

- 先在前端写字符串：会失去编译期穷尽校验。
- 只改 producer：重连或缓冲回放会丢失语义。
- 为暂缓生成而手改 generated client：下次生成会覆盖且契约仍不一致。
- 用默认成功或空状态吞掉未认识的事件：会掩盖协议错误。
