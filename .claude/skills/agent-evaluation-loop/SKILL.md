---
name: agent-evaluation-loop
description: Use when changing Litter-Bear agent prompts, models, routing, tools, planning, HITL policy, or streaming behavior and deciding whether the change is safe to release.
---

# 迭代智能体质量

## Overview

Agent 改动必须以可观测行为回归，而不是“这次回答看起来不错”。评测集来自脱敏的真实 trace 与明确的边界场景，并同时比较正确性、风险、时延和成本代理指标。

## 建立评测集

1. 阅读 `agent-loop-evolution.md`、`agent-chat-chain.md`、`conversation-trace` 与 admin observability。只抽取已获准且脱敏的数据；不得把用户文本、手机号、token、工具密钥写入 fixture。
2. 按变更声明可判定预期：路由模式/工具组、是否调用工具、工具参数约束、审批是否先于副作用、SSE 事件顺序、错误类别和终态。避免只以最终自然语言逐字相等评分。
3. 最小覆盖包括 direct、只读工具、工具失败、无权限/无配置、需审批工具的 approve/reject/edit、断线恢复；涉及 Plan/Hybrid 时补步骤预算与提前收尾。
4. 为每次样本记录模型预设、输入版本、预期、实际决策、trace、任务时长、模型调用数和工具结果。路由降级或规划降级必须作为结果，不可从统计中静默剔除。

## 执行顺序

1. 先运行现有基线，冻结结果与阈值。
2. 只修改一个可解释变量，例如模型预设、路由 schema、工具或 prompt。
3. 对比基线：任务成功率、路由/工具正确率、拒绝违规调用率、审批前零副作用、平均时长、模型调用次数和工具失败率。
4. 失败样本先归类为契约、权限、模型、provider、工具、SSE 或评测预期问题；不要靠加 prompt 或切换模型掩盖未知根因。
5. 将已确认的失败样本加入回归集，再决定灰度、修复或回滚。

## 运行时真相

工具链应继续使用 `agent.stream({ streamMode: 'messages' })`。遇到工具 `400` 时，先用 `debug-tool-call.cjs` 和 `debug-agent.cjs` 分离 provider、agent 与事件映射；不得为了“trace 更完整”改回已知不兼容的 `streamEvents({ version: 'v3' })`。

## 发布门槛

没有证据时结论只能是“未验证”。高风险工具必须证明未审批时零副作用，审批后才执行；任何权限越权、任务终态不一致、未知事件被吞掉或成本显著劣化，都阻止发布。通过后保留样本版本、阈值和失败归类，供下一次对比。

## 常见误区

- 只手测一个成功对话：测不到降级、错误和恢复。
- 只看最终文本：会漏掉错误路由、越权工具和重复调用。
- 以 trace 数量代替质量：高频进度不等于有用审计。
- 用新模型覆盖旧问题：先定位 provider、工具或协议边界。
