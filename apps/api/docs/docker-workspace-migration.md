# 开发容器迁 pnpm workspace 布局 — 实施方案

> 更新于 2026-08-18。记录 `dev:docker:up` 因锁文件与基础镜像失效的排查结论与改造规格；Temporal 链路设计见 [agent-flow-architecture.md](./agent-flow-architecture.md)。
> 相关：[agent-flow-iterations.md](./agent-flow-iterations.md)、根 [AGENTS.md](../../../AGENTS.md)（项目边界与验证命令）

## 现象

把 Temporal 接进 compose、基础镜像换到 Node 24 之后，`pnpm --filter ./apps/api dev:docker:up` 在依赖层直接失败：

```
[ERR_PNPM_OUTDATED_LOCKFILE] Cannot install with "frozen-lockfile"
  because pnpm-lock.yaml is not up to date with <ROOT>/package.json
  Failure reason:
  specifiers in the lockfile don't match specifiers in package.json:
  * 11 dependencies were added: @temporalio/testing@1.22.0, @types/qrcode@^1.5.6,
    jest-environment-node@^30.4.1, @langchain/langgraph@^1.4.7, ...
```

报错只暴露了第一层。实际有四个问题叠在一起，修掉第一个会依次撞上后面三个。

## 根因

### P1 — 构建用的是迁移前遗留的旧锁文件

`docker-compose.yml` 的 `context: .` 让构建上下文停在 `apps/api`，Dockerfile 的 `COPY package.json pnpm-lock.yaml ./` 复制到的是 `apps/api/pnpm-lock.yaml`。这份文件是单仓时代的产物，由 `b2f2b37`「迁移到 apps/packages 布局（纯移动）」原样搬过来后再没更新过：

```
apps/api/pnpm-lock.yaml   Jul 20 16:20   grep -c temporalio → 0
pnpm-lock.yaml（仓库根）   Aug 18 17:10   apps/api importer 内 temporal / langgraph / qrcode 齐全
```

即拿今天的 `package.json` 去比一个月前的锁文件，报出的 11 个「新增依赖」正是这期间加的。`apps/mobile/pnpm-lock.yaml` 是同类遗留，同样的坑。

### P2 — `workspace:*` 无法在子目录上下文中解析

`apps/api/package.json` 依赖 `"@litter-bear/types": "workspace:*"`，该协议必须在 workspace 根（`pnpm-workspace.yaml` + `packages/types`）解析。只要构建上下文还是 `apps/api`，换任何锁文件都会失败在 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`。

**构建上下文必须提到仓库根**——这是本次改造的主体，P1 只是它的一个症状。

### P3 — Alpine 跑不了 Temporal

`@temporalio/core-bridge@1.22.0/common.js` 把平台硬编码，不检测 musl：

```js
const platformMapping = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' };
```

而 `releases/` 只提供 `{x86_64,aarch64}-unknown-linux-gnu`、`{x86_64,aarch64}-apple-darwin`、`x86_64-pc-windows-msvc`，没有 musl 产物。在 `node:24-alpine` 上它会去加载 glibc 的 `index.node`，dlopen 失败。

该包的 `scripts` 只有 `build-rust` 等手动命令、**没有** install/postinstall 钩子，因此不会现场用 Rust 编译，和 `onlyBuiltDependencies` 白名单也无关——单纯是没有可用的二进制。**必须换 glibc 基础镜像**，否则前两个问题修完，两个 worker 容器一启动就挂。

### P4 — pnpm 版本漂移

Dockerfile 用 `corepack prepare pnpm@latest --activate`，根 `package.json` 声明 `packageManager: pnpm@10.27.0`。构建不可复现，且未来 pnpm 大版本可能拒绝当前 lockfile 格式。一并钉死。

## 改动清单

| 文件 | 动作 |
| --- | --- |
| `.dockerignore`（仓库根） | 新建 |
| `apps/api/Dockerfile` | 重写为 workspace 感知 + 换 glibc 镜像 + 钉 pnpm 版本 |
| `apps/api/docker-compose.yml` | 上下文提根、卷挂载重排、新增 bootstrap 服务 |
| `apps/api/pnpm-lock.yaml` | 删除 |
| `apps/mobile/pnpm-lock.yaml` | 删除 |
| `apps/api/scripts/development-compose.spec.cjs` | 补 bootstrap 断言 |

`apps/api/package.json` 的 `dev:docker:*` 脚本不变——compose 文件仍留在 `apps/api`，只有它内部的 `context` 指向变了。

## 规格

### 1. 新建仓库根 `.dockerignore`

上下文提根后不加这个文件，会把根 `node_modules`（含 mobile 的 Taro 依赖树）整个塞进构建上下文。注意 `apps/mobile` / `apps/admin` **不能整目录排除**——锁文件校验需要它们的 `package.json`（见下一节）。

```
**/node_modules
**/dist
**/.turbo
**/coverage
**/*.log
.git
**/.env
**/.env.*
!**/.env.example
!apps/api/.env.agent-flow-e2e.example

# 只保留 package.json 参与锁文件校验，其余内容不进上下文
apps/mobile/*
!apps/mobile/package.json
apps/admin/*
!apps/admin/package.json
packages/assets/*
!packages/assets/package.json
packages/theme/*
!packages/theme/package.json

UI-Preview
backend
```

### 2. 重写 `apps/api/Dockerfile`

三条不可简化的约束：

- **必须复制全部 7 个 importer 的 `package.json`**（根 + `apps/{admin,api,mobile}` + `packages/{assets,theme,types}`）。`--frozen-lockfile` 会把镜像内找到的 importer 集合与 `pnpm-lock.yaml` 的 importer 集合对齐校验，缺一个就可能重新报 `ERR_PNPM_OUTDATED_LOCKFILE`。安装范围靠 `--filter` 收窄，不要靠少 COPY 来省事。
- **`apps/api/prisma` 必须在 `pnpm install` 之前 COPY**：`apps/api` 的 `postinstall` 是 `prisma generate`，schema 不在位就会失败。
- **`ENV HUSKY=0`**：镜像内没有 `.git`，跳过根 `prepare` 脚本。

`prisma/schema.prisma` 的 generator 未声明 `binaryTargets`，引擎在容器内按镜像自动探测，换 debian 不需要改 schema。

```dockerfile
# 构建上下文 = 仓库根（见 docker-compose.yml 的 context: ../..）
# 基础镜像必须是 glibc：@temporalio/core-bridge 无 musl 预编译
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate
WORKDIR /workspace
ENV HUSKY=0
ARG PNPM_REGISTRY=https://registry.npmjs.org/

# 锁文件校验要求全部 workspace importer 的 package.json 与 pnpm-lock.yaml 对齐
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/assets/package.json packages/assets/
COPY packages/theme/package.json packages/theme/
COPY packages/types/package.json packages/types/
# apps/api 的 postinstall 是 prisma generate，schema 必须先就位
COPY apps/api/prisma apps/api/prisma

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile \
      --filter "./apps/api..." \
      --store-dir=/pnpm/store \
      --registry="${PNPM_REGISTRY}" \
      --network-concurrency=4

FROM dependencies AS development
COPY packages/types packages/types
COPY apps/api apps/api
RUN pnpm --filter ./packages/types run build
WORKDIR /workspace/apps/api
EXPOSE 3000
CMD ["pnpm", "run", "start:dev"]

FROM dependencies AS builder
COPY packages/types packages/types
COPY apps/api apps/api
RUN pnpm --filter ./packages/types run build \
 && pnpm --filter ./apps/api run build

FROM ${NODE_IMAGE} AS production
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate
WORKDIR /workspace
ENV HUSKY=0
ARG PNPM_REGISTRY=https://registry.npmjs.org/

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/assets/package.json packages/assets/
COPY packages/theme/package.json packages/theme/
COPY packages/types/package.json packages/types/
COPY apps/api/prisma apps/api/prisma

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod \
      --filter "./apps/api..." \
      --store-dir=/pnpm/store \
      --registry="${PNPM_REGISTRY}" \
      --network-concurrency=4

# @litter-bear/types 的 exports 全部指向 dist，运行时必须带上产物
COPY --from=builder /workspace/packages/types/dist packages/types/dist
COPY --from=builder /workspace/apps/api/dist apps/api/dist

WORKDIR /workspace/apps/api
EXPOSE 3000
CMD ["node", "dist/src/main"]
```

原 production 阶段末尾的 `RUN npx prisma generate` 可以删掉：`prisma` 在 `dependencies` 里，`--prod` 安装时 `postinstall` 已经执行过一次。

### 3. 改写 `apps/api/docker-compose.yml`

#### (a) 构建上下文与卷挂载

原来 `- .:/app` 把 `apps/api` 挂到 `/app`，与 workspace 布局冲突。改为按包挂载——不要挂整个仓库根，macOS 上 bind mount 会把 mobile 的文件树一起拖进去：

```yaml
x-application-build: &application-build
  context: ../..
  dockerfile: apps/api/Dockerfile
  target: development
  args:
    PNPM_REGISTRY: ${PNPM_REGISTRY:-https://registry.npmjs.org/}

x-application-volumes: &application-volumes
  - ../../apps/api:/workspace/apps/api
  - ../../packages/types:/workspace/packages/types
  # 容器内 pnpm 软链指向 /workspace/node_modules/.pnpm，必须用具名卷挡住宿主目录
  - api_node_modules:/workspace/apps/api/node_modules
  - types_node_modules:/workspace/packages/types/node_modules
```

`app` 与两个 worker 服务：`volumes: *application-volumes`、`working_dir: /workspace/apps/api`，`command` 保持原样。顶层 `volumes:` 段把 `app_node_modules` 换成 `api_node_modules` 与 `types_node_modules`。

#### (b) 新增一次性 bootstrap 服务

必要性有两条：

1. `packages/types` 被 bind mount 覆盖，镜像里 build 出来的 `dist` 在开发态失效；而三个服务并发跑 `tsc` 写同一个 `dist` 会互相踩。
2. 现有 `app` 的 `command` 先跑 `db:migrate:deploy` 再 `start:dev`，两个 worker 只 `depends_on: temporal`，会在迁移完成前连上库——这是个既有的竞态，顺手一起收掉。

用一个跑完即退的服务把「建产物 + 迁移」串行化：

```yaml
  workspace-bootstrap:
    build: *application-build
    env_file:
      - .env
    environment:
      <<: *application-environment
    working_dir: /workspace
    volumes: *application-volumes
    depends_on:
      db:
        condition: service_healthy
    command: sh -c 'pnpm --filter ./packages/types run build && pnpm --filter ./apps/api run db:migrate:deploy'
    restart: 'no'
```

`app` / `temporal-orchestrator-worker` / `temporal-activity-worker` 三者的 `depends_on` 均追加：

```yaml
      workspace-bootstrap:
        condition: service_completed_successfully
```

`app` 的 `command` 相应简化为 `pnpm run start:dev`（迁移已移交 bootstrap）。

#### (c) 其余不动

`db` / `redis` / `temporal-db` / `temporal` / `temporal-ui` 与端口映射保持现状。

### 4. 删除遗留锁文件

```bash
git rm apps/api/pnpm-lock.yaml apps/mobile/pnpm-lock.yaml
```

可在根 `.gitignore` 加一行防复发：

```
apps/*/pnpm-lock.yaml
```

### 5. 补 `development-compose.spec.cjs`

现有测试通过 `docker compose config` 校验服务拓扑，cwd 为 `apiRoot`、`composeFile` 为绝对路径，`context: ../..` 会相对 compose 文件所在目录解析，测试路径本身无需改动。追加两条断言：

- `workspace-bootstrap` 服务存在；
- 三个应用服务都声明了 `condition: service_completed_successfully`（可按 `config` 输出中的出现次数 ≥ 3 断言）。

## 验证

```bash
# 1. 确认根锁文件本身干净（应无改动输出）
pnpm install --frozen-lockfile

# 2. 起容器
pnpm --filter ./apps/api dev:docker:up

# 3. compose 拓扑测试
node --test apps/api/scripts/development-compose.spec.cjs
```

第 2 步重点盯三件事，对应三个根因：

1. `pnpm install` 阶段不再报 `ERR_PNPM_OUTDATED_LOCKFILE`（P1 / P2 已修）；
2. `workspace-bootstrap` 以 exit 0 退出，`packages/types/dist` 有产物；
3. 两个 worker 容器进入 `Worker.run()`，不抛 `PrebuildError` 或 `.so` 加载错误（P3 已修）。

首次构建因换了基础镜像会全量重下依赖，慢属正常；后续有 pnpm store cache mount。

## 落地过程中新发现的五个问题

方案实施后逐个暴露，均已修复并实测通过，记录以免重踩。

### P5 — Docker Hub 直连不通，与 node24 tag 无关

`failed to resolve source metadata for docker.io/library/node:24-bookworm-slim: context deadline exceeded`。实测：

```
registry-1.docker.io   →  000  12.0s 超时
docker.m.daocloud.io   →  401   0.19s（401 是正常 token 挑战，服务可达）
```

之前 `node:24-alpine` 能过只因本地已缓存该镜像。改基础镜像会触发一次真实拉取，才把网络问题暴露出来。

两层处理：

1. `docker-compose.yml` 的 build args 增加 `NODE_IMAGE: ${NODE_IMAGE:-node:24-bookworm-slim}`，并在 `.env` / `.env.example` 补 `NODE_IMAGE` 键。compose 会自动读取同目录 `.env` 做插值，因此本地把值改成镜像源前缀即可，仓库默认值保持官方地址。
2. 给 Docker daemon 配 `registry-mirrors`（`~/.docker/daemon.json`），这是不污染仓库的根本修法，**改完需重启 Docker Desktop 生效**。

`PNPM_REGISTRY` 同理：默认日志里 npmjs.org 单请求耗时 10~25s，本地 `.env` 可改 `https://registry.npmmirror.com`。

### P6 — 路径过滤器 `./apps/api...` 的 `...` 不生效

`tsc: not found` + `WARN Local package.json exists, but node_modules missing`。实测：

```
pnpm --filter "./apps/api..."     → 只选中 apps/api
pnpm --filter "{./apps/api}..."   → 选中 packages/types + apps/api
```

写成 `./apps/api...` 时 pnpm 把整串当路径 glob，`...`（含依赖包）静默失效，`packages/types` 不被安装，其 `tsc` 随之缺失。**路径过滤器必须用花括号包裹**。Dockerfile 中 dependencies 与 production 两个阶段都要改。

### P7 — `packages/types` 的 spec 被纳入构建

`error TS2582: Cannot find name 'describe'`。本地能过是个**意外**：根 `node_modules/@types/jest` 存在一个 Jul 20 的残留 symlink（与两个过期锁文件同日），而根 `package.json` 并未声明该依赖，tsc 逐级向上查找 `node_modules/@types` 时误命中。干净环境（Docker / CI）必然失败。

顺带暴露一个既有 bug：`packages/types/dist` 里真的编译进了 `agent-flow-events.spec.js` / `.d.ts`。

修法是在 `packages/types/tsconfig.json` 加 `"exclude": ["src/**/*.spec.ts"]`。该 spec 本就由 apps/api 的 jest 执行（其 `roots` 含 `packages/types/src`，且 apps/api 有 `@types/jest`），不属于发布产物。

### P8 — Temporal healthcheck 用 localhost 连不通

`dependency failed to start: container api-temporal-1 is unhealthy`，但 server 日志显示已完全正常启动。健康探针连续失败 22 次：

```
dial tcp [::1]:7233: connect: connection refused
```

`auto-setup` 只在容器对外 IP 上监听 7233，不绑 loopback —— 容器内 `localhost` 解析到 IPv6 `[::1]`、`127.0.0.1` 同样拒绝，**只有服务名可用**：

```yaml
test: ['CMD', 'tctl', '--address', 'temporal:7233', 'cluster', 'health']
```

实测该命令返回 `temporal.api.workflowservice.v1.WorkflowService: SERVING`、退出码 0。镜像内只有 `tctl`，没有 `temporal` CLI / `grpc_health_probe` / `nc`。

### P9 — `node --watch` 打崩编排 Worker

```
RangeError: Invalid atomic access index
  at completePatchActivationCallback (@temporalio/worker/src/workflow/patch-activation-callback.ts:105)
```

A/B 实测：容器内去掉 `--watch` 跑同一入口，Worker 稳定 RUNNING 满 70s；带 `--watch` 必崩。**与 Node 24 无关**（`@temporalio/worker` 的 engines 是 `>= 20.3.0`）。

机制：`threaded-vm.js:187` 是 `new Worker(require.resolve('./workflow-worker-thread'))`，**未传 `execArgv`**，worker_thread 因此继承父进程 `process.execArgv` 里的 `--watch`，污染 SharedArrayBuffer 传递 —— `getHeader()` 拿到的不再是 SAB 视图，`new Int32Array(...)` 退化成 length 0，`Atomics.store(header, 0, 1)` 索引越界。

修法：`start:temporal-worker:dev` 去掉 `--watch`（`package.json` 是 JSON 不能写注释，原因记在此处）。

**代价**：两个 worker 失去热重载，改完需 `docker compose restart temporal-orchestrator-worker temporal-activity-worker`。若要恢复热重载，需引入 `nodemon` / `ts-node-dev` 这类**以子进程方式**重启的 watcher（子进程 execArgv 干净，不会被污染），但那是新增依赖，需另行决策。

## 遗留：缺失的数据库迁移

`app` 与 `temporal-activity-worker` 启动后持续告警：

```
The table `public.agent_flow_signal_outbox` does not exist in the current database.
```

核对结果：`schema.prisma:505` 有 `model AgentFlowSignalOutbox`（`@@map("agent_flow_signal_outbox")`），但 `prisma/migrations/` 下**没有任何 SQL 包含这张表** —— 迁移未生成。`workspace-bootstrap` 的 `migrate deploy` 只应用已有迁移，因此报 "All migrations have been successfully applied" 仍缺表。

按仓库约定迁移只能由 Prisma 从 schema 生成、且由用户本地执行，此项留待补跑。

## 不在本次范围

- `apps/api/package.json` 的 `@types/node` 仍是 `^22.10.7`，运行时已是 Node 24。不影响构建，但类型定义偏旧，建议后续单独升到 `^24`。
- `docker-compose.agent-flow-e2e.yml` 目前只有 postgres + redis，不含 temporal，也不走 Dockerfile 构建，本次不受影响。但若 e2e 之后要覆盖 Temporal 链路，会撞上同一个 P3。
