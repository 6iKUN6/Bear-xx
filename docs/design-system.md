# 设计系统与共享 UI 约定

跨端设计系统（主题 / 设计 token / 共享组件）的**单一约定源**。所有前端遵循本文：当前仅 `apps/mobile`；后续 `web` / `admin` / `desktop` 落地时一并遵守。

> 状态：**规划中**。多端技术栈尚未确定，涉及栈的部分标注「待定」，栈定后按 [AGENTS.md](../AGENTS.md) 的「维护本文」流程增补——不提前编造。

## 已确立原则

- **设计 token 单一源**：颜色 / 间距 / 圆角 / 字号 / 阴影 / 渐变 / 动效集中定义，各端引用同一份语义变量，不各写一套色值。
- **语义变量优先**：用途导向的 token（文本 / 表面 / 主色 / 状态色 / 渐变）优先于硬编码色值；仅品牌色、图表色、状态色或设计稿明确要求的局部视觉可例外。
- **值一致、单位在边界换算**：token 的语义与色值跨端一致；单位差异（小程序/H5 的 rpx ← rem vs web 的 px）在各端消费边界处理，不污染 token 定义。
- **先 spike 再共享组件**：像 `packages/types/protocol` 那样，先验证「组件到底能共享到什么程度」（纯 token / 纯逻辑 vs 真正的组件复用），**不预设全端复用**。跨端渲染层差异（Taro 组件 vs DOM vs desktop）是主要约束。
- **packages 不反向依赖 apps**；app 私有业务 UI 不进 packages。

## 当前现状（`apps/mobile`）

- 主题 token 定义在 `apps/mobile/src/app.css` 的 `:root`，前缀 `--lb-*`：
  - 背景：`--lb-bg-start/mid/end`、`--lb-surface`、`--lb-surface-strong/border`、`--lb-line-soft`
  - 文本：`--lb-text-primary/secondary/muted`
  - 渐变 / 品牌：`--lb-grad-a/b/c`、`--lb-grad-warm-a/b`
  - 状态：`--lb-danger`
  - 阴影：`--lb-shadow-soft/card/glow`
- 样式栈：TailwindCSS + `weapp-tailwindcss`（rem → rpx），组件内以 `text-[var(--lb-*)]` 等消费 token。
- UI 打磨 skill：`shape`（定方向）→ `impeccable`（构建）→ `critique` / `polish`（评审收尾），见 [skills-setup.md](./skills-setup.md)。

## 目录规划（待建，非现状）

| 位置 | 职责 |
| --- | --- |
| `packages/theme` | 设计 token / 主题变量单一源（从 mobile 的 `--lb-*` 提炼） |
| `packages/ui` | 跨端共享组件（范围由 spike 结论决定） |

抽离时机：出现**第二个前端**、确有跨端复用需求时再抽，不提前造包。

## 待定决策（技术栈确定后补）

- `web` = 复用 Taro H5 target，还是独立标准 React（Next / Vite）？—— 决定组件共享是否需处理 `weapp-tailwindcss` vs 标准 Tailwind 差异。
- `desktop` = Electron / Tauri？—— 共享边界大概率以 token / 逻辑为主。
- `admin` 技术栈？
- 共享组件方案：跨端组件抽象层 vs 各端各自实现 + 共享 token/逻辑。

## 关联文档

- [AGENTS.md](../AGENTS.md) — 根编排约定与「维护本文」流程
- [skills-setup.md](./skills-setup.md) — 设计/打磨 skill 安装
- `apps/mobile/AGENTS.md` — 移动端细则（组件目录、命名、样式约定）
