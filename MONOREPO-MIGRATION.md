# Monorepo 迁移 Checklist

> 目标：把单 repo（`backend/` + `frontend/`）正式化为 `apps/` + `packages/` 的 pnpm workspace + turbo。
> 原则：先移动（纯 `git mv`，保留 history），再改配置，最后抽包。每阶段一个提交，在 `chore/monorepo` 分支进行，**每阶段停下 review，不推远端**。
> 前提：Node 24（≥22.12，满足 `require(esm)`，共享包可 ESM 单包，无需双格式）。

## 目标结构

```
repo/
├─ apps/
│  ├─ api/        # 原 backend（NestJS，:3000，Prisma）
│  └─ mobile/     # 原 frontend（Taro，H5+小程序多端）
│  # web/admin/docs 等真需要时再加
├─ packages/
│  └─ types/                # @litter-bear/types 共享类型
│     └─ src/protocol/      # 流式通讯协议（子路径 @litter-bear/types/protocol）
├─ package.json / pnpm-workspace.yaml / pnpm-lock.yaml / turbo.json
```

## 阶段 0 · 前置 ✅（本提交）
- [x] 新建分支 `chore/monorepo`
- [x] `.nvmrc`=24 + 根 `engines.node>=22.12`
- [x] 本迁移文档

## 阶段 1 · 目录移动（纯 `git mv`，单独提交）
- [ ] `mkdir -p apps`
- [ ] `git mv backend apps/api`
- [ ] `git mv frontend apps/mobile`
- [ ] `packages/types/src/protocol` 种子就位（已验证 ESM 可被两端消费）
- [ ] commit：`chore: 迁移到 apps/packages 布局`（只有重命名）

## 阶段 2 · Workspace + Turbo
- [ ] `pnpm-workspace.yaml`：`packages: ['apps/*','packages/*']`
- [ ] `turbo.json`：`build` 配 `dependsOn:['^build']`（保证 types 先构建）；`dev` `cache:false persistent:true`；`lint`/`typecheck`
- [ ] 根 `package.json` 加 turbo 脚本 + 装 `turbo`；保留 husky/commitlint
- [ ] **`.npmrc`（Taro + pnpm 头号坑）**：`shamefully-hoist=true` 或 `public-hoist-pattern[]=*tarojs*` / `*tailwind*`
- [ ] 根 `pnpm install`（单一 root lockfile；清理旧 lock / `.pnpm-store`）

## 阶段 3 · 抽 `packages/types`
- [ ] 完成包：ESM（`type:module`、`module:ESNext`、`declaration`），`exports` 暴露 `.` 与 `./protocol`；纯 枚举/常量/类型（无顶层 await）
- [ ] 把 `apps/api/.../stream-task/stream-task-event.types.ts` 定义收敛进 `packages/types/src/protocol`；后端原文件改为 `export * from '@litter-bear/types/protocol'`（渐进）
- [ ] `apps/api`、`apps/mobile` 加依赖 `"@litter-bear/types": "workspace:*"`
- [ ] 前端 SSE 消费改用 `@litter-bear/types/protocol` 的 `StreamEventType`（替掉手抄字符串）

## 阶段 4 · 修跨 app / 路径引用
- [ ] **orval 保留，只改路径**（它管 REST 客户端，protocol 管 SSE 事件，互补不冲突）：
  - `apps/mobile` `generate:api:local`：`../backend/scripts/export-openapi.cjs` → `../api/scripts/...`
  - `apps/mobile/orval.config.ts` `LOCAL_OPENAPI_PATH`：`../backend/docs/openapi.json` → `../api/docs/openapi.json`
  - orval 产物**暂留 `apps/mobile`**（当前 `taroRequest` mutator 绑死 Taro）；等出第二个前端再提升为 `packages/api-client` 并把 http mutator 做成可注入
- [ ] 两 app 各自 `@/*` 别名不变；确认 Nest tsc 解析 ESM 包（`esModuleInterop` 已开，spike 验证通过）
- [ ] Taro `config/index.ts` `sourceRoot/outputRoot` 相对 `apps/mobile` 不变

## 阶段 5 · 部署 / CI
- [ ] `.github/workflows/*`：`working-directory`/构建路径 → `apps/api`、`apps/mobile`；可接 turbo 缓存
- [ ] 部署：`node dist/main` → `apps/api/dist/main`（或 `pnpm --filter api build` 后在 `apps/api` 起）
- [ ] Prisma：确认 `apps/api` schema 路径与 `prisma generate`

## 阶段 6 · 验证
- [ ] `pnpm --filter @litter-bear/types build`
- [ ] `pnpm --filter api build` + 起服务（:3000 端口避让仍在）
- [ ] `pnpm --filter mobile build:weapp`（重点回归：含共享包的小程序构建）
- [ ] 端到端"深圳天气"：`strategy.selected → tool.call.* → message.delta`
- [ ] `pnpm turbo build` 全绿

## 已知坑
1. **Taro + pnpm hoisting**（阶段 2 的 `.npmrc`）——最可能翻车，移动后第一件事就验证 `build:weapp`。
2. `weapp-tailwindcss` + tailwind v4 postcss 在 workspace 下的插件解析。
3. 共享包 `types` 必须先 build（turbo `^build` 覆盖）。
4. 单一 lockfile 重装会重排 node_modules，重装后两端都要重新 build 确认。
