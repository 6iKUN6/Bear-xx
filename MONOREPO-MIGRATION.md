# Monorepo 迁移 Checklist

> 目标：把单 repo（`backend/` + `frontend/`）正式化为 `apps/` + `packages/` 的 pnpm workspace + turbo。
> 原则：先移动（纯 `git mv`，保留 history），再改配置，最后抽包。每阶段一个提交，在 `chore/monorepo` 分支进行，**每阶段停下 review，不推远端**。
> 前提：Node 24（≥22.12，满足 `require(esm)`，共享包可 ESM 单包，无需双格式）。
> 分支：`chore/monorepo`（从 `feat-RegularIteration` 顶端 `4347d47` 拉出）。

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

## 阶段 0 · 前置 ✅ `cedfc88`
- [x] 新建分支 `chore/monorepo`
- [x] `.nvmrc`=24 + 根 `engines.node>=22.12`
- [x] 本迁移文档

## 阶段 1 · 目录移动（纯 `git mv`）✅ `b2f2b37`
- [x] `git mv backend apps/api`、`git mv frontend apps/mobile`（293 个重命名，history 保留，node_modules 随迁）
- [x] `packages/types/src/protocol` 种子就位

## 阶段 2 · Workspace + Turbo ✅ `c14f8d5`
- [x] `pnpm-workspace.yaml`：`apps/* + packages/*`；`onlyBuiltDependencies` 放行 prisma/esbuild/@tarojs/binding 等
- [x] `turbo.json`：`build(dependsOn ^build)` / `dev` / `lint` / `typecheck`
- [x] 根 `package.json`：turbo 脚本 + `packageManager: pnpm@10.27.0` + turbo devDep
- [x] `.npmrc`：`shamefully-hoist=true`
- [x] 根 `pnpm install`（单一 lockfile；`CI=true --no-frozen-lockfile`）
- [x] `apps/api` 加 `postinstall: prisma generate`

## 阶段 3 · 抽 `packages/types` ✅ `a90b37c`
- [x] ESM 包（`type:module`、`module:ESNext`、`declaration`），`exports` 暴露 `.` 与 `./protocol`，并补 `default` 条件兼容后端 nodenext `require(esm)`
- [x] 后端 `stream-task-event.types.ts` 改为 `export ... from '@litter-bear/types/protocol'`（既有 import 全不变）
- [x] `apps/api`、`apps/mobile` 加依赖 `@litter-bear/types: workspace:*`
- [x] 前端 `stream-event.types` re-export 枚举、`streamFeedback` 复用共享中文文案

## 阶段 4 · 修跨 app / 路径引用 ✅ `9778320`
- [x] orval 保留仅改路径：`generate:api:local` 与 `orval.config.ts` 的 `../backend/...` → `../api/...`
- [x] AGENTS.md（根 + mobile）目录/链接/OpenAPI/UI 路径更新
- [x] 两 app `@/*` 别名不变；Nest nodenext 解析 ESM 包已验证

## 阶段 5 · CI（占位，不执行）✅ `49ed384`
> 调整：现未到部署阶段，不改部署路径，改为**手动触发的 CI 空模板**避免 merge main 报错。
- [x] 删除过时 `ci-backend.yml`（旧路径 `Litter-Bear-Server`）
- [x] 新增 `ci.yml`：仅 `workflow_dispatch`，不监听 push/pull_request；内置注释好的 turbo 构建作业待启用
- [x] Prisma：`apps/api` schema 路径 + `postinstall: prisma generate`（阶段 2 已接）
- [ ] （部署阶段再做）部署脚本 `node dist/main` → `apps/api/dist/main`；启用 workflow 触发器

## 阶段 6 · 验证
- [x] `pnpm build`（turbo：`@litter-bear/types` + api 双双成功）
- [x] `pnpm --filter ./apps/mobile build:weapp`（556 模块，含共享包）
- [x] `apps/api` 起服务：`running on :3000` + DB/Redis 连接 + 运行时 `require(esm)` 加载共享包成功 + `api-docs` 200
- [ ] 端到端"深圳天气"（需前端 + 登录态，用户手动确认）：`strategy.selected → tool.call.* → message.delta` + 中文状态展示

## 已知坑
1. **Taro + pnpm hoisting**（`.npmrc shamefully-hoist`）——已验证 weapp 构建通过。
2. `weapp-tailwindcss` + tailwind v4 postcss 在 workspace 下的插件解析（构建已通过）。
3. 共享包 `types` 必须先 build（turbo `^build` 覆盖）。
4. 单一 lockfile 重装会重排 node_modules，重装后两端都要重新 build 确认。
5. 共享包 ESM + `exports` 仅 `import` 会导致后端 CJS `require` 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`——已加 `default` 条件解决。
