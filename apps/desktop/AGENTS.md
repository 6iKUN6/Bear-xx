# apps/desktop（Sola 桌面端）开发约定

就近细则源；跨仓通用约束见根 `AGENTS.md`。本端品牌是 **Sola**，不用办伴 / banban IP。

## 定位与边界

- **桌面工作台**：基本对话 + 后续自定义工作流（AI 小说 / 视频等，由后端 AgentFlow 驱动）。UI 语言参考 Codex 桌面端：中性、留白、助手消息无气泡卡片、执行轨迹为可折叠活动行。
- 技术栈：Electron 壳（electron-vite，main / preload / renderer 三段）+ React 19 + Vite 7 + Tailwind 4（`@tailwindcss/vite`）+ Zustand + lucide-react；后续打包用 electron-builder。
- **只消费 C 端接口**（`/auth`、`/chat` SSE），**不碰 `/admin/*`**；流式事件契约从 `@litter-bear/types/protocol` 引，不手抄字符串。
- 渲染层样式只走 `--lb-*` 语义变量（`@litter-bear/theme` 四套常规主题，不含 admin 的 pixel 主题），不写死色值；markdown 渲染与 trace 逻辑用 `@litter-bear/markdown` / `@litter-bear/chat-core`，不各写一份。

## 结构

```txt
src/main/       主进程：单窗口、原生标题栏（v1 不自绘）、安全基线（contextIsolation +
                sandbox + 关 nodeIntegration，外链一律 shell.openExternal）
src/preload/    contextBridge 白名单桥（window.sola），只放只读环境信息与后续主进程
                能力；不开通用 ipcRenderer
src/renderer/   React 19 渲染层
  src/stores/     Zustand：theme-store（--lb-* 注入 :root + localStorage 持久化）、
                  app-store（页内路由 workbench/settings/login + 登录态）、chat-store
  src/components/ 页面与组件（页内路由，不引 react-router）
  src/mocks/      骨架阶段演示数据，SSE / API 接入后整个删除
electron.vite.config.ts  三段构建，产物统一 dist/{main,preload,renderer}
```

- 主进程 / preload 打 **CJS**（本包不开 `"type":"module"`），规避 ESM preload 的 sandbox 限制。
- 页内路由用 `app-store` 的 `page` 状态切换（三页面结构参考 `UI-Preview/desktop-workbench-v1.html` 原型），不引 react-router——页面数量撑不起来。
- 登录不做整窗拦截：入口在侧边栏左下角账号行。

## 验证

```bash
pnpm --filter ./apps/desktop run typecheck   # tsconfig.node + tsconfig.web 双工程
pnpm --filter ./apps/desktop run build       # electron-vite build（三段）
pnpm --filter ./apps/desktop run dev         # 起 Electron 窗口调试（默认不主动跑）
```

## 当前状态与路线

已完成：① API 层（admin 风格手写 client → C 端）+ 真实登录 ② 会话列表 + SSE 对话 ③ markdown / trace / HITL 卡片（`@litter-bear/markdown` 渲染正文；`@litter-bear/chat-core` 折叠执行轨迹与审批参数；审批走 `POST /stream-tasks/:taskId/approval` 续跑）④ 智能体选择器（GET /agents；composer 上方 AgentMenu 下拉；send 带 agentId，flow 随智能体绑定走）⑤ electron-builder 打包 ⑥ 模型/思考强度选择。

**模型/思考选择**：生效智能体 = 选中的 ?? 默认（isDefault && canUse）。`GET /agents/:id/models` 返回模型闭集 + 思考能力目录（`ModelReasoningCapability`）；自定义 Flow Agent 的 models 为空，`ModelMenu` 自然隐藏。`model-store` 按 agentId 缓存选项、解析初值（本地记忆 > Agent 默认 > 列表首个）、localStorage 持久化每个 agent 的最近选择；切模型时思考重置为该模型目录默认。思考控件（状态/强度/预算）完全由能力目录的 `configurable`/`values` 驱动，不按模型名推断。发送时 `send` 带 `selectedModelPresetId` + `reasoning`（`ReasoningSelection` 复用 `@litter-bear/types` 共享契约）；服务端仍按允许集合与能力重新校验，本地值只作初值。logout/401 时 reset。

**打包（electron-builder）**：配置在 `electron-builder.yml`。renderer 已被 electron-vite 全部内联，主/preload 仅用 electron 与 node 内置，所以 `files` 只发 `dist/**` + `package.json`，显式排除 `node_modules/**`（否则 pnpm workspace 依赖会被收进 asar，白白多 17MB）。`electronDownload.mirror` 指向 npmmirror（electron-builder 下载发行版走自己的下载器，不吃 `ELECTRON_MIRROR`）。本地构建 `mac.identity: null` 跳过签名（本机时间戳服务不可达）；正式发布要签名/公证时删掉该行并配 CSC 环境变量。图标 `resources/icon.png`（1024×1024，暖橙渐变 + 白 S，源文件 icon.svg）。命令：`pnpm package`（dmg+zip，arm64+x64）/ `pnpm package:dir`（仅当前架构 app 目录，快速验证）。产物在 `release/`（已 gitignore）。

组件分工：`AssistantMessage`（消息组装：轨迹 + 审批卡 + 正文）、`TraceBlock`（执行轨迹折叠行）、`ApprovalCard`（HITL 三态审批）、`MarkdownContent` / `StreamingMarkdownContent`（正文渲染，流式叠末尾 shimmer）、`AgentMenu`（智能体选择下拉）、`ModelMenu`（模型预设选择下拉，只管模型单选）、`ThinkingMenu`（思考设置下拉：思考开关 Switch + 强度下拉 + 预算，跟随当前模型 capability）、`Switch`（轻量 button + role="switch" 开关，未引 Radix）。chat-store 用模块级 `activeStream` 跟踪当前任务的 taskId / lastEventId（桌面端同一时间一条活动流），供审批续跑续传；agent-store 管智能体列表与选中项（轻量无本地缓存）；model-store 管模型选项缓存与每智能体的选择（localStorage 持久化）；logout/401 时三者一起 reset。
