---
name: theme-adapter-mobile
description: Use when a shared Litter-Bear theme must be connected to Taro mobile, theme persistence fails, or H5 and WeChat Mini Program render the same token differently.
---

# 适配移动端主题

## Overview

`@litter-bear/theme` 只定义跨端语义值；`apps/mobile` 负责持久化、运行时变量注入和平台单位换算。修复必须落在拥有该职责的一侧。

## 固定边界

| 位置 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `packages/theme` | token、主题闭集、CSS 变量映射 | React、Taro、存储和 rpx |
| `themeStore` | 合法主题 ID 的持久化与恢复 | 业务状态与接口调用 |
| `PageShell` | 读取主题并向页面根注入 `--lb-*` | 保存第二套 token |
| `app.css` | 默认主题的启动回退与 Tailwind 入口 | 完整主题色板 |

## 工作流

1. 阅读 `docs/design-system.md`、`apps/mobile/AGENTS.md`、`themeStore.ts`、`PageShell`、`app.css` 与 `config/index.ts`。
2. 将问题定位为：持久化 ID、变量注入、组件消费、Tailwind 扫描/优先级，或 H5/微信的单位转换。不要先全局替换 `rem` 与 `rpx`。
3. 主题 ID 无效时用 `isThemeId` 回退到 `defaultThemeId`；切换不得触发导航、登录、接口或会话清理。
4. 为运行时 style 中的单位值检查小程序实际产物。构建期的 `rem2rpx` 只在非 H5 生效，不能改成全端统一转换。
5. 保持 `app.css` 的 `source(none)` 扫描边界，且 H5 不把 Tailwind utilities 放进 CSS layer；原型目录不得进入业务扫描范围。

## 验证

改动 `themeStore`、`PageShell` 或主题消费时执行 `pnpm --filter ./apps/mobile run typecheck` 与 `build:weapp`。改动样式入口、Tailwind 或平台配置时也执行 `build:h5`。检查冷启动、选择主题、重启恢复、切换后的聊天与审批卡；分别在 H5 和小程序确认尺寸、圆角、阴影与长文本没有漂移。

## 常见误区

- 在 `app.css` 追加当前主题：会绕过 store 与 `PageShell`。
- 为小程序直接改 token 单位：会污染 H5 和未来 web 消费端。
- 仅看 H5：动态 CSS 变量与 WXSS 编译的行为并不完全相同。
- 移除 `source(none)` 让原型被扫描：会引入小程序不支持的 WXSS 规则。
