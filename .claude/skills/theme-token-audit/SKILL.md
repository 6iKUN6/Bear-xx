---
name: theme-token-audit
description: Use when Litter-Bear UI has hard-coded colors, shadows, radii, or theme-ID branches, or when a component becomes unreadable in one of the existing themes.
---

# 审计主题令牌

## Overview

主题审计按视觉语义迁移存量样式，而不是机械地把所有常量替换成变量。目标是让四个 mobile 主题都能正确表达页面、内容语法和状态反馈。

## 范围与取证

1. 阅读 `docs/design-system.md`、目标目录的 `AGENTS.md` 和相邻组件；先确认该页面用 Tailwind、SCSS 还是运行时 style。
2. 搜索目标目录中的 hex、`rgba`、固定阴影/圆角、`bg-white`、品牌色和 `themeId` 分支。搜索结果是候选项，不是自动替换清单。
3. 用所有主题复现问题，记录元素、状态和背景色；问题只在某个主题出现时，优先检查该主题的语义 token。

## 迁移规则

| 发现 | 处理 |
| --- | --- |
| 页面/卡片背景 | `--lb-page-background`、`--lb-surface*` |
| 文字、边线、按钮 | `--lb-text-*`、`--lb-line-*`、`--lb-accent*` |
| 成功、警告、错误 | 对应状态 token 及其 `Soft` 表面 |
| 常规阴影、圆角 | `--lb-shadow-*`、`--lb-radius-*` |
| 代码块、Markdown 语法高亮 | 可保留刻意的内容样式；记录原因 |

不要用固定白色、紫色或主题 ID 条件分支修局部可读性。先选择已有 token；若多个组件缺少同一语义，才在 `packages/theme` 扩充 token，并同步全部主题与 CSS 变量映射。

## 跨端边界

保留项目既有 Tailwind/rem 写法，不把小程序的 rpx 换算塞进 token 或全局 CSS。运行时注入 CSS 变量时，检查 `PageShell` 与构建期 `rem2rpx` 的职责边界。

## 验证

先执行最小检索复核，确认无意保留重复色板。改动 mobile 后执行 `pnpm --filter ./apps/mobile run typecheck` 与 `build:weapp`；样式入口或 H5 受影响时补 `build:h5`。至少在问题主题和对照主题下检查默认、按压、禁用、错误/警告和长文本状态。

## 常见误区

- 只按色值替换：同一颜色在不同位置可能分别表示强调、错误或内容语法。
- 为一个组件加主题特例：会让第五个主题或 admin 端继续失效。
- 修改生成的 WXSS 或 generated API：应修改源码与共享契约。
- 只看默认暖色主题：深色 `mono-tool` 最容易暴露对比问题。
