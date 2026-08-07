---
name: agent-tool-onboarding
description: Use when adding, changing, or exposing a LangChain or MCP tool to a Litter-Bear agent, especially when it has user data, cost, external side effects, or approval requirements.
---

# 接入智能体工具

## Overview

工具是受控运行时能力，不是聊天 service 的快捷调用。只有被 `CapabilityRegistry` 注册并经 `CapabilityResolver` 装配的能力，模型才能承诺和执行。

## 接入流程

1. 阅读 `apps/api/AGENTS.md`、`agent-loop-evolution.md`、`agent-chat-chain.md`，以及目标工具/服务的真实 schema。
2. 定义明确输入、输出、错误和用户归属校验。模型输入、检索内容、外部 MCP 结果都不可信；工具自身必须完成权限、参数和副作用校验。
3. 将工具注册到语义化工具组。只读、低风险工具可按需进入基础组；费用、写入、下单、上传或外部动作不得靠 prompt 约束，必须设 `requiresApproval: true`。
4. 确认 `StrategyRouter` 的结构化决策只能选择已注册的 group/skill，且 `CapabilityResolver` 的结果实际传入 executor。不得在 `ChatService`、controller 或普通业务 service 直调工具。
5. MCP 工具需要异步加载时，先解决 registry 的同步构造边界；不能以未加载的工具名伪装能力已可用。

## 不可绕过的约束

| 需求 | 正确边界 |
| --- | --- |
| 真实费用或外部写操作 | `requiresApproval` + HITL + 可审计结果 |
| 工具执行失败 | 抛出/映射真实错误，不伪造成功 observation |
| 模型调用 | 业务层经 `LlmService` 与 provider factory |
| 工具流式反馈 | 统一 agent 事件映射器和 StreamTask/SSE 管线 |

## 验证

先用实际 schema 做最小工具调用；按改动范围运行 `node apps/api/scripts/debug-tool-call.cjs`、`debug-router.cjs`，有审批则 `debug-hitl.cjs`。再执行 `pnpm --filter ./apps/api run build` 与 `lint:check`。验证工具实际执行、拒绝时未执行、错误事件与用户归属都正确。

## 常见误区

- 在 chat controller/service 直接调用：会绕过任务恢复、trace、能力闭集和审批。
- 仅在 prompt 写“执行前确认”：模型文本不是安全门禁。
- 把高成本工具放进 default：会扩大可调用面与意外支出。
- 注册名称却未接 schema/实现：属于虚假能力，路由不能选择。
