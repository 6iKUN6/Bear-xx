# 多主题共享包设计

## 目标

建立 `packages/theme` 作为前端主题 token 的单一来源，实现并注册 UI Preview 中的四套主题：

- A：暖色工作台
- B：纯粹黑白工具
- C：柔软陪伴助手
- D：原版紫色渐变

首个消费端为 `apps/mobile`。小程序用户可在「我的」页面切换主题，选择结果立即生效并持久化。后续独立 Web 应用复用同一主题定义，不复制色值。

本次不建立 `packages/ui`，不抽取跨端 React/Taro 组件，也不改变现有业务、接口、SSE 或 HITL 流程。

## 模块与依赖

```text
packages/theme/
  package.json
  tsconfig.json
  src/
    types.ts
    css-variables.ts
    themes/
      warm-workbench.ts
      mono-tool.ts
      soft-companion.ts
      purple-gradient.ts
      index.ts
    index.ts

apps/mobile/src/
  components/
    PageShell/
    ThemePicker/
  store/themeStore.ts
```

`packages/theme` 是不依赖 React、Taro、Tailwind、Zustand 或任何 app 的纯 TypeScript 模块。`apps/mobile` 依赖该包，并负责小程序存储、页面接线和交互。

## 主题接口

主题由数据对象实现，不使用 class。每个主题文件导出一个通过 `satisfies ThemeDefinition` 校验的不可变对象。

```ts
export type ThemeId =
  "warm-workbench" | "mono-tool" | "soft-companion" | "purple-gradient";

export type ThemeColorScheme = "light" | "dark";

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  shortName: string;
  description: string;
  colorScheme: ThemeColorScheme;
  tokens: ThemeTokens;
  swatches: readonly string[];
}
```

`ThemeTokens` 使用平台无关的语义字段，覆盖：

- 页面、普通表面、抬升表面、弱表面和悬停表面
- 主文本、次文本和弱文本
- 普通边线和强边线
- 强调色、强调色深色、强调色弱背景、强调色文字、强调表面
- 成功、信息、提醒、危险及各自的弱背景
- 卡片阴影、浮层阴影
- `xs`、`sm`、`md` 圆角

`accentSurface` 和 `pageBackground` 允许保存合法 CSS background 值，使 D 主题可以表达渐变，其他主题使用纯色。

公开接口为：

```ts
themes;
defaultThemeId;
getTheme(themeId);
isThemeId(value);
createThemeCssVariables(theme);
```

调用方不需要了解主题注册表和字段到 CSS 变量的映射实现。

## 主题注册

四个主题分别位于独立文件。`themes/index.ts` 显式导入并注册主题，同时建立按 `ThemeId` 查找的内部索引。

新增主题时必须：

1. 新增一个实现 `ThemeDefinition` 的主题文件。
2. 扩展 `ThemeId` 闭集。
3. 在主题注册表中登记。

不支持运行时注入未知主题，也不对非法主题 ID 做多字段兼容。`isThemeId` 用于持久化数据校验；非法值明确回到 `defaultThemeId`。

## CSS 变量适配

`createThemeCssVariables` 将语义 token 转换为稳定的 `--lb-*` CSS 变量映射。变量名属于共享主题包的公开契约，mobile 和未来 Web 使用同一组变量。

主题文件使用小程序可解析的 hex、rgba、线性渐变和阴影值，不直接输出 `oklch()`。A/B/C 的值依据 UI Preview 视觉转换为兼容色值；D 保留原紫粉蓝渐变。

mobile 不保留主题色值，只将变量映射序列化为 Taro `View` 支持的内联 style 字符串。

## Mobile 接入

### 状态

`themeStore` 保存当前 `ThemeId`，提供：

- `hydrate()`：读取本地主题并校验。
- `setTheme(themeId)`：持久化并切换主题。

存储键为 `litter_bear_theme`。默认主题为 `warm-workbench`。存储读取失败或值非法时使用默认主题，不伪装成其他主题。

### 页面根节点

`PageShell` 是 mobile 内部模块，负责：

- 读取当前主题。
- 获取共享主题定义。
- 在页面根 `View` 注入 CSS 变量。
- 应用现有 `appPageClass` 页面壳样式。

五个页面统一迁移到 `PageShell`。变量在页面根节点向下继承，因此 NavBar、TabBar、聊天输入框、Markdown、流式状态和审批卡片不需要分别订阅 store。

应用启动时与登录态、会话数据一起调用 `themeStore.hydrate()`。

### 主题选择器

「我的」页面新增独立的主题区域。`ThemePicker` 使用 2 列布局展示四个可触控选项，每项包含：

- A/B/C/D 短名称
- 主题名称
- 共享主题定义提供的色板 swatch
- 当前选中状态

选择后立即调用 `setTheme`。主题区域不嵌入现有设置卡片，避免卡片嵌套。

## 视觉迁移

当前 mobile 中仍有部分 `bg-white`、固定圆角、固定阴影和状态色。为保证四套主题真实生效，本次同步完成：

- 白色表面改为语义 surface 变量。
- 主要卡片、按钮、输入框和导航圆角改为主题 radius 变量。
- 主按钮和品牌图标使用 `accentSurface`，支持 D 渐变。
- 页面壳使用 `pageBackground`，支持暗色 B 和渐变 D。
- 状态反馈继续使用 success/info/warning/danger 语义变量。
- 删除 `apps/mobile/src/app.css` 中的主题值，只保留基础页面规则和必要的主题消费类。

业务特定尺寸、布局和排版不进入共享主题包。

## 错误与兼容

- 包仅接受闭集内的 `ThemeId`。
- 本地存储异常不阻止页面启动，记录现有 storage 层错误行为并使用默认主题。
- 所有页面使用自定义导航栏，无需同步微信原生导航栏颜色。
- CSS 变量注入作用于 Taro 页面根节点，适配小程序并继续兼容现有 H5 构建。
- 不增加旧主题字段或旧存储格式兼容层。

## 验证

实施完成后执行：

```bash
pnpm --filter @litter-bear/theme run build
pnpm --filter ./apps/mobile run typecheck
pnpm --filter ./apps/mobile run build:weapp
pnpm --filter ./apps/mobile run build:h5
```

同时检查：

- 四个主题均已注册，默认主题为 A。
- 非法持久化值会回到默认主题。
- mobile 源码不存在重复主题色板。
- 小程序构建产物包含四套主题变量所需的消费规则。
- `.vscode/settings.json` 和其他用户已有改动不被修改。
