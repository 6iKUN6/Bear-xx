# 设计系统与共享 UI 约定

跨端设计系统（主题 / 设计 token / 共享组件）的**单一约定源**。所有前端遵循本文：当前仅 `apps/mobile`；后续 `web` / `admin` / `desktop` 落地时一并遵守。

> 状态：主题模块已落地，当前消费端为 `apps/mobile`；共享 UI 组件仍处于 spike 阶段。
> 品牌定位、文案语气与视觉表达见 [brand-foundation.md](./brand-foundation.md)；本文只约束跨端 token 与组件实现。

## 已确立原则

- **设计 token 单一源**：颜色 / 间距 / 圆角 / 字号 / 阴影 / 渐变 / 动效集中定义，各端引用同一份语义变量，不各写一套色值。
- **语义变量优先**：用途导向的 token（文本 / 表面 / 主色 / 状态色 / 渐变）优先于硬编码色值；仅品牌色、图表色、状态色或设计稿明确要求的局部视觉可例外。
- **值一致、单位在边界换算**：token 的语义与色值跨端一致；单位差异（小程序/H5 的 rpx ← rem vs web 的 px）在各端消费边界处理，不污染 token 定义。
- **先 spike 再共享组件**：像 `packages/types/protocol` 那样，先验证「组件到底能共享到什么程度」（纯 token / 纯逻辑 vs 真正的组件复用），**不预设全端复用**。跨端渲染层差异（Taro 组件 vs DOM vs desktop）是主要约束。
- **packages 不反向依赖 apps**；app 私有业务 UI 不进 packages。

## 主题模块（`packages/theme`）

`@litter-bear/theme` 是跨端主题单一源，为纯 TypeScript ESM 包，不依赖 React、Taro、Tailwind、Zustand 或任何 app。

四套主题为闭集：

| Theme ID          | 名称             | 色彩模式 |
| ----------------- | ---------------- | -------- |
| `warm-workbench`  | A · 暖色工作台   | light    |
| `mono-tool`       | B · 纯粹黑白工具 | dark     |
| `soft-companion`  | C · 柔软陪伴助手 | light    |
| `purple-gradient` | D · 原版紫色渐变 | light    |

每套主题在 `packages/theme/src/themes/` 下独立实现，通过 `satisfies ThemeDefinition` 校验，由 `themes/index.ts` 显式注册。主题是不可变配置数据，不使用 class。

公开接口：

```ts
import {
  createThemeCssVariables,
  defaultThemeId,
  getTheme,
  isThemeId,
  themes,
  type ThemeDefinition,
  type ThemeId,
  type ThemeTokens,
} from "@litter-bear/theme";
```

- `themes`：按 A/B/C/D 顺序排列的只读主题列表。
- `defaultThemeId`：默认主题 `warm-workbench`。
- `getTheme(themeId)`：读取闭集内主题。
- `isThemeId(value)`：校验持久化或外部输入。
- `createThemeCssVariables(theme)`：转换为稳定的 `--lb-*` CSS 变量映射。

`ThemeTokens` 仅包含跨端语义：页面/表面/文本/边线/强调色/状态色/阴影/圆角。业务布局、组件尺寸和 app 私有视觉不进入主题包。

主题使用小程序可解析的 hex、rgba、阴影和线性渐变值，不直接输出 `oklch()`。单位差异继续在消费端处理。

## Mobile 接入

- `apps/mobile/src/store/themeStore.ts` 负责主题选择的本地持久化，存储键为 `litter_bear_theme`。
- `apps/mobile/src/components/PageShell` 在页面根节点注入共享 CSS 变量，所有子组件通过继承消费。
- `apps/mobile/src/components/ThemePicker` 在「我的」页面展示四套主题色板。
- `apps/mobile/src/app.css` 的 `:root` 只保留默认 A 的启动首帧回退值；该回退不是第二套主题定义，不得扩展出其他主题。
- mobile 组件使用 `var(--lb-*)`，不得保存 A/B/C/D 的完整色板或自行判断主题 ID。
- 主题切换不进入业务 store，不触发接口、导航、会话或认证操作。

当前 mobile 样式栈为 TailwindCSS + `weapp-tailwindcss`（rem → rpx）。共享变量通过 `text-[var(--lb-text-primary)]` 等 utility 或 SCSS 中的 `var(--lb-*)` 消费。

## 共享 UI 状态

| 位置             | 状态   | 职责                                  |
| ---------------- | ------ | ------------------------------------- |
| `packages/theme` | 已实现 | 主题定义、语义 token、CSS 变量映射    |
| `packages/ui`    | 未创建 | 是否共享渲染组件由后续 Web spike 决定 |

Web 接入时优先直接消费 `@litter-bear/theme`。不要把 Taro `PageShell` 或 `ThemePicker` 移入 packages；Web 使用自己的 DOM 适配层和组件实现。

## 待定决策（技术栈确定后补）

- `web` 的标准 React 构建方案（Vite / Next）与路由方案。
- `desktop` = Electron / Tauri？—— 共享边界大概率以 token / 逻辑为主。
- `admin` 技术栈？
- 共享组件方案：跨端组件抽象层 vs 各端各自实现 + 共享 token/逻辑。

## 关联文档

- [AGENTS.md](../AGENTS.md) — 根编排约定与「维护本文」流程
- [skills-setup.md](./skills-setup.md) — 设计/打磨 skill 安装
- `apps/mobile/AGENTS.md` — 移动端细则（组件目录、命名、样式约定）
- [brand-foundation.md](./brand-foundation.md) — 办伴的品牌表达与视觉方向
