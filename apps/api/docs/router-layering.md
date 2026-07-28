# API Router 分层约定

全局前缀 `api`（`app.constants.ts`）。所有 controller 按**受众**分两层，鉴权与命名遵循下表约定，新增端点须归入对应层。

## 端侧（mobile / 普通用户）

面向已登录的终端用户，`JwtAuthGuard`（按用户隔离数据，无角色要求）。

| 前缀 | controller | 说明 |
|---|---|---|
| `/auth/*` | auth | 登录/刷新/登出（公开，无 guard） |
| `/user/*` | user | 个人资料 |
| `/conversations/*` | conversation | 会话 CRUD（按 userId 隔离） |
| `/chat/*` | chat | `POST /chat/message`（SSE 首轮）等；绑真实会话、落库 |
| `/stream-tasks/*` | stream-task | 任务查询/续跑/取消/审批（SSE 恢复） |
| `/agents`（GET） | agent | 列表/详情（登录可读，供端侧选择智能体） |

## 管理端（admin）

`/admin/*` 前缀，一律 `JwtAuthGuard + RolesGuard + @Roles('ADMIN')`（`RolesGuard` 查库取角色，即时生效）。

| 前缀 | controller | 说明 |
|---|---|---|
| `/admin/observability/*` | admin | 只读观测聚合（overview/agents/tools/errors/tasks/tasks/:id），默认排除 `isTest` 任务 |
| `/admin/agent-tests` | admin-agent-test | `POST`（SSE）流式测试 agent；任务打 `isTest` 标记，不进观测统计 |
| `/admin/model-presets` | admin-model-preset | 模型预设 CRUD；**apiKey 不落库/不返回**，仅元数据 + env 密钥就绪标记 |

写操作（`/agents` 的 POST/PATCH/DELETE、`/admin/*` 全部）额外 `RolesGuard + @Roles('ADMIN')`。

## 约定

- 新增管理端能力 → 归入 `/admin/*`，套 `JwtAuthGuard + RolesGuard + @Roles('ADMIN')`；**不塞进 `/chat` 等端侧前缀**。
- 端侧与管理端**不共用** SSE 入口：mobile 用 `/chat/message`，admin 测试用 `/admin/agent-tests`（语义、限流、鉴权分离）。
- 浏览器消费 SSE 需带 Bearer → 用 `fetch + ReadableStream`（EventSource 无法带 Authorization）。
- CORS 全开（`main.ts` 的 `app.enableCors()`）；生产收敛时按来源白名单配置。
