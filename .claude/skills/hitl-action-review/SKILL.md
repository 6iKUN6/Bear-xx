---
name: hitl-action-review
description: Use when a Litter-Bear agent tool can spend money, create an order, write external data, upload or publish content, or otherwise needs user approval before execution.
---

# 审核高风险智能体动作

## Overview

HITL 是工具执行前的强制门禁，不是模型说“请确认”的一段文本。当前已实现 ReAct 工具级审批：任务暂停为 `WAITING_HUMAN`，用户决定后从同一检查点续跑。

## 风险判定

| 工具特征 | 策略 |
| --- | --- |
| 只读、无费用、无敏感数据外泄 | 可免审批，仍要权限与参数校验 |
| 费用、下单、写入、上传、发布、不可逆外部动作 | `requiresApproval: true` |
| 敏感数据读取/跨用户访问 | 先做服务端授权和最小数据披露；审批不能替代权限 |

## 接入流程

1. 阅读 `apps/api/docs/hitl.md`、`agent-chat-chain.md`、`CapabilityRegistry` 与审批 DTO/前端卡片。
2. 在注册工具时标记 `requiresApproval`；由 resolver 产出 `approvalToolNames`，并透传到 ReAct agent 的 HITL middleware。不得在 controller、prompt 或前端单独实现“确认”。
3. 设计脱敏审批信息：动作名、用户可理解的影响、可编辑参数、费用/风险提示和允许决定。不得把 token、内部 prompt 或不必要个人数据下发到卡片。
4. 保持 `taskId = thread_id`、同一 checkpointer 和首轮等价的工具/策略配置。审批端点必须校验任务属主与 `WAITING_HUMAN`，只接受 `approve`、`reject`、`edit` 的明确语义。
5. 首轮中断后发 `approval.required`，不得写 `message.done` 或 `COMPLETED`；approve 才执行，reject 回注拒绝，edit 仅用校验后的参数执行。审批结果也应进入可审计 trace。

## 已知边界

HITL 当前仅覆盖 ReAct。Plan/Hybrid 是手写 controller，不在 LangGraph 检查点图中；需要其中途审批时，先将编排迁为可检查点的 `StateGraph` 并持久化首轮决策，不能假装现有标记已生效。

## 验证

运行 `node apps/api/scripts/debug-hitl.cjs`：首轮工具未执行，approve 后才执行；再覆盖 reject、edit、再次中断、断线恢复和非属主提交。执行 API `build`、`lint:check`，并检查 `approval.required`、`WAITING_HUMAN`、续跑和终态的顺序。

## 常见误区

- 用 prompt 代替 `requiresApproval`：没有安全性。
- 因赶期跳过审批：高风险工具不能有紧急旁路。
- 将 Redis 决定当作长期检查点：重启或 TTL 后会失去恢复点。
- 在 Plan/Hybrid 中复用 ReAct 的说明文字却不改编排：会制造无法续跑的假能力。
