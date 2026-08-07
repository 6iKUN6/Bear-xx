---
name: theme-authoring
description: Use when Litter-Bear needs a new selectable UI theme, a theme palette is incomplete, or product language must become cross-platform semantic design tokens.
---

# 创建主题

## Overview

主题是 `@litter-bear/theme` 的不可变语义数据，不是页面上的一组色值。先确定消费范围，再补全 token；页面和组件只消费 `--lb-*` 变量。

## 开始前

1. 阅读 `docs/design-system.md`、`packages/theme/src/types.ts`、`packages/theme/src/themes/index.ts`，以及目标端的 `AGENTS.md`。
2. 判定主题归属：mobile 可选主题进入 `themes` 与 `ThemeId`；仅 admin 的像素主题进入 `pixelThemes` 与 `PixelThemeId`。不得为了“只给某端使用”在 app 内另存整套色板。
3. 明确是新增完整主题、修正现有 token，还是组件缺少语义。只有跨组件可复用的视觉含义才新增 token。

## 工作流

1. 用“页面、表面、文本、边线、强调、状态、阴影、圆角”描述主题意图；不要从单一品牌色外推全部界面。
2. 在 `packages/theme/src/themes/` 新建或修改独立定义，以 `as const satisfies ThemeDefinition` 保证所有 `ThemeTokens` 完整。
3. 更新显式注册表、类型和测试。`createThemeCssVariables` 只在 token schema 变化时修改；变量名必须稳定，不能由字符串拼接推导。
4. mobile 选择器直接消费 `themes`。`apps/mobile/src/app.css` 只可保留默认主题的首帧回退，不得扩展为第二个主题源。
5. 修正局部可读性时，先判断应调现有语义 token、补新语义 token，还是内容语法样式的刻意例外；不得用主题 ID 分支或硬编码白色/紫色覆盖。

## 检查表

| 检查项 | 要求 |
| --- | --- |
| token 完整性 | `ThemeTokens` 中每个语义都有值，含状态色与 `onAccent` |
| 消费边界 | app 不保存主题色板，不按 theme ID 条件渲染视觉 |
| 主题隔离 | mobile 常规主题与 admin 像素主题不混入同一列表 |
| 视觉质量 | 重点检查文本、按钮、错误/警告、审批卡和流式消息 |

## 验证

至少执行 `pnpm --filter @litter-bear/theme run test`。改动 mobile 消费端时，再执行 `pnpm --filter ./apps/mobile run typecheck` 与 `build:weapp`；涉及 H5 样式或构建配置时补 `build:h5`。在受影响主题下检查主题选择器、聊天、审批卡和长文本，无法完成的平台视觉检查须明确记录为未验证。


## 常见误区

- 只改 `accent`：文本、悬浮面、状态与阴影会失去层次。
- 在 `app.css` 添加完整主题：会产生第二个主题源。
- 为单个页面复制一套 token：应先验证是否为跨组件语义。
- 用 CSS 编译通过代替视觉验证：编译无法发现对比度、动态变量和小程序单位问题。
