# apps/admin 开发约定

管理后台的细则源。跨仓约定见根 `AGENTS.md`（冲突时根文件优先级更低，但**不得违反**其中的安全与诚实条款）。

## 定位与边界

内部工具，只服务 ADMIN 角色。**不是终端用户产品**：

- 只消费 `/admin/*` 端点。需要非 admin 端点时，先问「这件事该不该在后台做」，而不是直接加请求。
- 移动端 / 未来 web 客户端的功能不放进这里；这里的 Flow 编排、可观测、调试会话也不外流到 C 端。
- 除 `/login` 外的所有页面都在 `RequireAdmin` + `AppShell` 布局路由下（`App.tsx`）。新增页面必须挂进该路由，并在 `components/app-shell.tsx` 的导航数组里加一项。

现有页面：概览、智能体、智能体管理、模型预设、Flow 编排、工具、任务、错误、调试会话。

## 技术栈

Vite 5 + React 18 + TypeScript 5.7 · react-router-dom 6 · TanStack Query 5 · Zustand 5 · Radix (dialog/select/slot) · TailwindCSS 3.4 · lucide-react · recharts · sonner。

- 路径别名只有 `@/*` → `./src/*`（`vite.config.ts` + `tsconfig.json` 两处）。
- dev server 端口 5273。API base 由 `VITE_API_BASE_URL` 决定，**默认 `http://127.0.0.1:3000` 而非 localhost**——macOS 上 localhost 优先解析 `::1`，别的进程绑在 `[::1]:3000` 时请求会被劫持并表现成 CORS 错误。改这个默认值前先读 `src/api/client.ts` 的注释。
- 目录是**一文件一页面**（`src/pages/xxx.tsx`），不是 mobile 的一文件夹一页面。别照搬 mobile 的结构。

## API 层

三层，职责不重叠：

```txt
src/api/client.ts     request()：拼 /api 前缀、注入 bearer、解 {code,data,message} 信封、
                      401 自动刷新重试一次、失败清凭证跳登录、非 2xx 抛 ApiError
src/api/endpoints.ts  一个端点一个瘦函数，只写 path/method/body，不含业务逻辑
src/hooks/queries.ts  TanStack Query 的 useXxx / useXxxMutations，负责缓存键与失效
```

- **`src/api/types.ts` 是手写对齐后端 DTO 的，不走 orval。** 这是有意选择（只消费十几个端点）。代价是：改后端 `/admin/*` 的 DTO 时必须手工同步这里，**漂移不会有任何工具报错**。改后端 admin DTO 的同一个 commit 里就把它改掉。
- 错误一律 `err instanceof ApiError ? err.message : "兜底文案"`。服务端的拒绝原因（如「该 Flow 已被 3 个任务运行过」）要原样透出，不要替换成通用文案。
- 流式测试走 `src/api/stream.ts`，事件类型从 `@litter-bear/types/protocol` 引入，**不在此手抄事件名字符串**。

### 缓存失效

写操作的 `onSuccess` 要失效**所有**受影响的 key。典型漏洞是只失效列表忘了详情——`useAgentFlowMutations(flowId)` 同时失效 `["agentFlows"]` 与 `["agentFlow", flowId]` 就是为此。

一个 `useXxxMutations()` 里的多个 mutation **共享 `variables`**。想按行显示 spinner 时不要用 `mutation.isPending && mutation.variables === row.id`：并发触发两行会让先发起的那行提前失去 spinner。用本地 `Set<string>` 记在途 id（见 `pages/models.tsx`）。

## 样式与主题

- 颜色**只用语义 token**，不写具体色值：Tailwind 的 `border/background/foreground/primary/secondary/muted/destructive` 指向 `index.css` 的桥接变量，桥接变量再指向 `@litter-bear/theme` 的 `--lb-*`。
- 语义色（成功/警告/危险/信息）在 Tailwind 里没有映射，直接写 `text-[var(--lb-danger)]` / `bg-[var(--lb-success-soft)]`。
- Badge 的 `variant` 已覆盖 `success/warning/destructive/info/outline/secondary`，**优先用它而不是自己拼 className**。
- 主题切换由 `stores/theme-store.ts` 把 `--lb-*` 写进 `:root`；像素主题额外挂 `.theme-pixel` + `data-pixel`，专属钩子在 `pixel.css`。`index.css` 里的 `--lb-*` 只是首帧回退值，改它不改变实际主题。
- `design-demo/` 是独立 HTML 预览，不参与构建。

## 组件约定

- `components/ui/*` 是 shadcn 风格的原语（cva + `cn()`）。**新增页面先看这里有没有现成的**，不要在页面里重造按钮/表格/徽章。
- 编辑类交互统一用 Sheet（`agent-form-sheet` / `model-preset-form-sheet` 是范式）；需要宽度的（如 JSON 编辑）才开独立路由页（`flow-detail.tsx`）。
- 派生状态优先在渲染期同步，不用 `useEffect` 回灌（eslint 未装 `react-hooks` 插件，effect 依赖写错不会被发现）。范式见 `pages/flow-detail.tsx` 的 `syncedKey`。
- 闭集的中文展示元数据放 `src/lib/*-meta.ts`（`agent-meta` / `model-preset-meta` / `flow-meta`），页面和表单共用一份。未登记的取值**回退原始串**，不要 fallback 到某个已知档位——那会把陌生状态显示成绿灯。

## 诚实呈现

后台是判断线上状态的地方，比 C 端更不能糊：

- 状态徽章必须区分「正常」「未配置」「不可用」。没有发布版本的 Flow 显示「未发布」而不是留空；没配密钥的模型预设显示红标而不是中性色。
- 探测/校验类结果按真实档位分级，不要一律 `toast.success`。「能对话但工具往返没通」是 warning，不是成功。
- 校验按钮针对的是**已保存**的版本时，草稿脏着要禁用并说明原因，不能让用户拿到过时结论。
- 密钥只显示服务端下发的脱敏 hint，前端不做任何拼接或还原。

## 验证

```bash
pnpm --filter ./apps/admin run typecheck
pnpm --filter ./apps/admin run lint
pnpm --filter ./apps/admin run build   # tsc --noEmit + vite build
```

lint 里 `no-explicit-any` 只是 warning，但根 `AGENTS.md` 禁止用 `any` 绕类型——按根文件执行，不要因为 lint 放过就用。

改动涉及 `packages/theme` 或 `packages/types` 时，跑全仓 `pnpm build`（turbo 会先构建 packages）。

默认不启 dev server，除非用户明确要求。
