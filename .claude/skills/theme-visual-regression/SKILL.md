---
name: theme-visual-regression
description: Use when changing Litter-Bear themes, semantic tokens, shared visual components, or cross-platform styling that could visually regress existing screens.
---

# 验证主题视觉回归

## Overview

构建成功只能证明 CSS 可编译，不能证明主题可读、状态可辨或动态变量在双端一致。本 skill 以受影响范围建立最小视觉矩阵，而不是要求每次穷举全站。

## 建立矩阵

1. 列出本次改变的 token、组件和端。默认 mobile 主题是 `warm-workbench`、`mono-tool`、`soft-companion`、`purple-gradient`；admin 像素主题只在改动其消费端时另测。
2. 选择受影响的页面与状态：`PageShell`、主题选择器、聊天气泡/输入、流式进度、审批卡、错误/重试、长文本或长参数。新增 token 必须覆盖其正常与异常语义。
3. 选取至少一个对照主题。`mono-tool` 是深色对比度检查的必选项；浅色主题用于确认深色修复没有反噬。

## 验收标准

| 维度 | 通过条件 |
| --- | --- |
| 可读性 | 文本、边线、图标与状态背景可辨，长文本不重叠或溢出 |
| 状态 | 默认、按压、禁用、等待、成功、警告、错误均有清晰层级 |
| 主题隔离 | 切换主题不触发业务操作，不混入 admin 专属主题 |
| 跨端 | H5 与小程序的尺寸、圆角、阴影和 Tailwind 布局没有明显漂移 |

## 执行与记录

先运行受影响包的测试、`typecheck` 和 `build:weapp`；样式入口或 H5 受影响时补 `build:h5`。遵守根 `AGENTS.md`：默认不启动开发服务。已有运行环境或用户要求启动时，用截图核对矩阵，并记录主题、页面、状态、平台和结果；不能取得某平台时明确写“未验证”，不以编译替代截图。

## 常见误区

- 只看默认主题：最容易遗漏深色 `mono-tool` 的前景色问题。
- 只截静态首页：审批、流式和错误态才会消费状态 token。
- 把专门的代码块/Markdown 内容色当作应用 chrome 回归：先确认它是否为刻意的内容语法例外。
- 因赶时间跳过视觉检查：可以缩小矩阵，不能把未检查写成已通过。
