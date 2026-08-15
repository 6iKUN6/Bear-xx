# AgentFlow 后端实施迭代计划

> **For agentic workers:** 实施时按阶段逐项执行，任何阶段未通过验收不得开始下一阶段。
> **目标：** 在不破坏现有聊天、SSE、HITL 和 MCP 安全边界的前提下，交付可版本化、可导入导出、由 Temporal 持久化执行的 AgentFlow 后端。
> **架构：** Flow JSON 与版本是控制面事实源；Temporal 负责 Flow 的长任务编排；LangGraph 保留为 Agent 节点内部执行器；`StreamTask` 保持客户端任务与 SSE 事实源。
> **目标技术栈：** NestJS、Prisma/PostgreSQL、Redis、Temporal TypeScript SDK、LangChain/LangGraph、Zod、Jest。当前工程尚未安装 Temporal SDK，也没有 Workflow、Worker、AgentFlow 模型或 `flow.*` 事件；它们从阶段 2、4、5 分别引入。
> **提交纪律：** 每阶段保持可独立 review；未经用户明确要求，不执行 `git commit`。

---

## 实施前条件

1. 使用 Temporal Cloud 或可访问的自建 Temporal 环境，明确 Namespace、前端地址、鉴权方式和 worker 部署位置。
2. 为开发、测试和生产环境分别提供 Temporal Namespace；禁止 worker 默认连生产 Namespace。
3. 保持 `DATABASE_URL`、Redis、MCP 和现有模型配置正常；Temporal 不能替代 PostgreSQL 中的业务事实。
4. 数据库变更只改 `apps/api/prisma/schema.prisma`。开发者本地运行 `pnpm --filter ./apps/api run db:migrate` 生成迁移；AI 不创建或编辑 `migration.sql`。

## 阶段 0：冻结契约与补齐特征测试

**目的：** 为后续替换运行时建立行为安全网，避免 Flow 化改变现有 Direct、ReAct、PlanExecute、Hybrid 的用户语义。

**涉及文件：**

- 新建：`apps/api/src/modules/ai/agent-loop/execution/plan-graph.runner.spec.ts`
- 修改：`apps/api/src/modules/ai/agent-loop/agent-loop-runner.service.spec.ts`
- 修改：`packages/types/src/protocol/events.ts`
- 修改：`packages/types/src/protocol/payloads.ts`
- 修改：`apps/api/docs/agent-chat-chain.md`
- 修改：`apps/api/docs/stream-task-architecture.md`
- 修改：`apps/api/docs/hitl.md`
- 修改：`apps/api/docs/llm-provider-config.md`
- 修改：`apps/api/docs/router-layering.md`
- 修改：`apps/api/docs/plan-graph-migration.md`

**工作项：**

1. 为 `PlanGraphRunner` 写确定性单测，替身 `PlannerService`、模型、`CommonChatAgentFactory` 和 `StepEvaluator`，不依赖真实模型。
2. 固定五个用例：Plan 全步骤完成、Hybrid 提前结束、计划审批四种决定、两轮工具审批恢复、planner 文本不泄漏进 `message.delta`。
3. 为已有 `AgentLoopRunnerService` 增加“策略快照不能被恢复期重路由覆盖”的断言。
4. 为新 Flow SSE 事件先定义共享协议类型与中文文案；`flow.waiting_human` 必须带 `approvalId`，并以可判别的工具/计划审批载荷完整承载现有审批卡片所需安全字段。本阶段不从生产链路发送它们。
5. 同步现状文档：明确 Plan/Hybrid 已由 `PlanGraphRunner` 承担；补齐 `StreamTaskEvent` / `StreamTaskRun` / trace / `WAITING_HUMAN` 的持久化边界，MCP `create-order` 审批策略、Redis 的短期职责、模型预设数据库优先级与完整路由清单。

**验证：**

```bash
pnpm --filter ./apps/api test -- plan-graph.runner.spec.ts
pnpm --filter ./apps/api test -- agent-loop-runner.service.spec.ts
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check
```

**完成标准：** 新增测试在旧实现上稳定通过；协议改动不影响既有事件类型；未引入 Temporal 依赖或数据库迁移。

## 阶段 1：Flow JSON 的纯领域模块

**目的：** 实现与 Temporal、Nest、数据库无关的 FlowDefinition 解析、验证、标准化和 digest，使 JSON 可安全成为唯一可导入导出的工件。

**涉及文件：**

- 新建：`packages/types/src/agent-flow/index.ts`
- 新建：`packages/types/src/agent-flow/definition.ts`
- 新建：`apps/api/src/modules/agent-flow/definition/flow-definition.schema.ts`
- 新建：`apps/api/src/modules/agent-flow/definition/flow-definition.validator.ts`
- 新建：`apps/api/src/modules/agent-flow/definition/flow-definition.digest.ts`
- 新建：`apps/api/src/modules/agent-flow/definition/flow-definition.validator.spec.ts`
- 修改：`packages/types/src/index.ts`

**工作项：**

1. 在共享包定义只读的 `FlowDefinition`、`FlowNode`、`FlowEdge`、`FlowPolicy` 和节点 config 判别联合。该包不得导入 `apps/api`。
2. 用 Zod 在 API 侧实现 `schemaVersion=1` 的 JSON 解析；解析失败返回字段路径、规则名和中文说明。
3. 实现结构校验：节点 id、唯一入口、可达终点、edge 存在性、禁止通用循环、`condition.when` 枚举、Policy 数值范围和 layout 大小。
4. 实现忽略 `layout` 的 canonical JSON 序列化及 SHA-256 digest；相同语义 Definition 不得因对象字段顺序或画布坐标改变 digest。
5. 提供四个内置模板生成器：Direct、ReAct、PlanExecute、Hybrid；模板输出必须通过同一校验器，而非手写旁路。
6. 编写单测：相同 Definition 的 digest 稳定、未知节点拒绝、环拒绝、PlanLoop 合法、layout 不影响 digest、非法 edge 拒绝。

**验证：**

```bash
pnpm --filter @litter-bear/types run build
pnpm --filter ./apps/api test -- flow-definition.validator.spec.ts
pnpm --filter ./apps/api run build
```

**完成标准：** 任意 Flow JSON 均能被确定性解析为“有效 Definition”或可展示的校验错误；尚不落库、不开放 HTTP 端点。

## 阶段 2：控制面持久化、草稿与发布

**目的：** 将 FlowDefinition 变为版本化领域对象，并让管理员可创建、修改、校验、导入、导出、发布和回滚。

**涉及文件：**

- 修改：`apps/api/prisma/schema.prisma`
- 新建：`apps/api/src/modules/agent-flow/agent-flow.module.ts`
- 新建：`apps/api/src/modules/agent-flow/agent-flow.service.ts`
- 新建：`apps/api/src/modules/agent-flow/agent-flow-version.service.ts`
- 新建：`apps/api/src/modules/agent-flow/agent-flow-approval.service.ts`
- 新建：`apps/api/src/modules/agent-flow/agent-flow.controller.ts`
- 新建：`apps/api/src/modules/agent-flow/dto/create-agent-flow.dto.ts`
- 新建：`apps/api/src/modules/agent-flow/dto/update-agent-flow-version.dto.ts`
- 新建：`apps/api/src/modules/agent-flow/dto/import-agent-flow.dto.ts`
- 新建：`apps/api/src/modules/agent-flow/dto/agent-flow-response.dto.ts`
- 新建：`apps/api/src/modules/agent-flow/agent-flow.service.spec.ts`
- 修改：`apps/api/src/app.module.ts`

**工作项：**

1. 在 Prisma 中定义 `AgentFlow`、`AgentFlowVersion`、`AgentFlowApproval` 和最小审计模型；添加 `Agent.defaultFlowVersionId` 与 `StreamTask` Flow 快照字段。`AgentFlowApproval.id` 即 `approvalId`，保存 task/run/trace 关联、类别、安全请求摘要、决定和状态，并用条件更新保证一个审批只能从 `PENDING` 决定一次。关系删除策略必须防止已被任务引用的发布版本物理删除。
2. 实现创建 Flow 时同时创建 version 1 DRAFT；DRAFT 修改覆盖同一草稿 JSON，发布后的版本拒绝更新。
3. 发布前串行化事务执行：读取 DRAFT、执行结构校验、执行能力闭集校验、写 digest、归档旧发布版本、设置新 `publishedVersionId`。
4. 导入端点只接受 JSON 文件内容，解析后创建新的 DRAFT；导出端点只返回 Definition JSON，不暴露数据库 ID、审计记录、任务数据或密钥。
5. 回滚端点仅允许切换该 Flow 的历史 PUBLISHED/ARCHIVED 版本；切换后产生审计记录，历史版本内容不可变。
6. 所有控制面端点使用 `JwtAuthGuard`、`RolesGuard`、`@Roles('ADMIN')`、DTO 校验和 Swagger 注解。
7. 测试并发发布、草稿修改、导入非法 JSON、导出 JSON、发布版本不可编辑、被任务引用版本不可删除，以及审批决定的重复提交与冲突提交。

**验证：**

```bash
pnpm --filter ./apps/api run db:migrate
pnpm --filter ./apps/api test -- agent-flow.service.spec.ts
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check
```

**完成标准：** 管理员能以 API 完成版本闭环；非管理员无法访问；发布操作原子且不可改变历史任务将要使用的 Definition。

## 阶段 3：能力闭集、运行时编译与 PlanGraph 拆分

**目的：** 把有效 FlowDefinition 编译为受控执行计划，并把 `PlanGraphRunner` 收敛为可复用的 PlanLoop 执行器。

**涉及文件：**

- 新建：`apps/api/src/modules/agent-flow/runtime/flow-runtime-validator.service.ts`
- 新建：`apps/api/src/modules/agent-flow/runtime/flow-compiler.service.ts`
- 新建：`apps/api/src/modules/agent-flow/runtime/flow-node-executor.types.ts`
- 新建：`apps/api/src/modules/agent-flow/runtime/flow-template.registry.ts`
- 新建：`apps/api/src/modules/ai/agent-loop/execution/plan-graph/plan-graph.definition.ts`
- 新建：`apps/api/src/modules/ai/agent-loop/execution/plan-graph/plan-graph.builder.ts`
- 迁移：`apps/api/src/modules/ai/agent-loop/execution/plan-graph.runner.ts` 至 `execution/plan-graph/` 下的 definition、builder、runner；旧入口在阶段内保留薄适配，验证后删除
- 修改：`apps/api/src/modules/ai/agent-loop/graphs/{plan-execute,hybrid-plan-react}.graph.ts`
- 修改：`apps/api/src/modules/ai/ai.module.ts`

**工作项：**

1. `FlowRuntimeValidator` 基于 `CapabilityRegistry` 和模型预设 registry 校验 `toolGroups`、skills、模型和风险策略；未知或静态无权能力在发布前失败。用户级 MCP 凭据只能在任务创建时按锁定凭据校验，缺失时必须阻止该任务启动，不能在运行时静默过滤该工具组。
2. `FlowCompiler` 的输入为锁定的 Definition 和任务上下文，输出为可执行的受限节点计划；禁止从字符串反射类名、导入模块或执行代码。
3. 定义 `FlowNodeExecutor` 的稳定接口：输入节点、运行快照和节点输入；输出标准化结果、摘要、下一边枚举或等待审批描述。所有执行器都从同一个事件/trace 适配层产出事件。
4. 将 `PlanGraphRunner` 拆为 definition、builder、runner 三个文件；`stream/resume/consume/finalize` 保持同一 Runner，Plan 与 Hybrid 继续复用 Builder。
5. 以 `PlanLoopPolicy { stopPolicy, planReview, maxSteps }` 替换核心逻辑对 `AgentStrategyMode` 的依赖；旧图包装器暂时映射为 Policy，待阶段 6 完成迁移后删除。
6. 为 compiler、runtime validator、PlanLoop policy 和四个预设模板编写确定性单测。

**验证：**

```bash
pnpm --filter ./apps/api test -- flow-runtime-validator
pnpm --filter ./apps/api test -- flow-compiler
pnpm --filter ./apps/api test -- plan-graph.runner.spec.ts
pnpm --filter ./apps/api run build
node apps/api/scripts/debug-plan-graph.cjs
```

**完成标准：** Flow JSON 不能绕过能力、审批和模型闭集；Plan/Hybrid 仍可完成现有诊断场景；`PlanGraphRunner` 不再承担 Flow 版本或 HTTP/SSE 职责。

## 阶段 4：Temporal 基础设施与独立 Worker

**目的：** 让长任务拥有进程外持久化调度、Timer、Signal、Activity retry 和 worker 接管能力。

**涉及文件：**

- 修改：`apps/api/package.json`
- 新建：`apps/api/src/temporal/temporal.config.ts`
- 新建：`apps/api/src/temporal/workflows/agent-flow.workflow.ts`
- 新建：`apps/api/src/temporal/workflows/agent-flow.workflow.spec.ts`
- 新建：`apps/api/src/temporal/worker.ts`
- 新建：`apps/api/src/modules/agent-flow/temporal/temporal-client.service.ts`
- 新建：`apps/api/src/modules/agent-flow/temporal/agent-flow.activities.ts`
- 新建：`apps/api/src/modules/agent-flow/temporal/agent-flow.activities.spec.ts`
- 修改：`apps/api/src/config/env.validation.ts`
- 修改：`apps/api/src/config/config.module.spec.ts`
- 修改：`apps/api/docs/agent-flow-architecture.md`

**工作项：**

1. 引入 Temporal TypeScript client、worker 与 workflow 依赖，配置 `TEMPORAL_ADDRESS`、`TEMPORAL_NAMESPACE`、`TEMPORAL_TASK_QUEUE` 和认证配置；启动时缺失关键配置必须失败，不允许退化为内存 workflow。
2. 创建纯 Workflow：加载冻结 run snapshot、调度节点 Activity、等待审批 Signal、执行 Timer、处理 cancel Signal、选择下一条确定性 edge、调用任务收尾 Activity。
3. 创建独立 worker 启动入口，按 `workflow` 与 `activity` 角色启动两个 worker 进程组：前者只注册 Workflow，后者启动 Nest application context 并注册 Activity。HTTP API 进程不承担 worker 轮询。
4. `TemporalClientService` 以 `StreamTask.id` 作为 Workflow ID 启动任务，处理已存在 Workflow 的幂等启动响应。
5. Activity 使用 task/node execution identity 进行事件和状态去重；LLM/工具 Activity 设置有限 timeout、重试策略与非重试错误类别。
6. 为 Workflow 写 Temporal 测试环境测试：审批 Signal、审批超时、取消、可重试 Activity、不可重试 Activity 和 worker 接管后重放。

**验证：**

```bash
pnpm --filter ./apps/api test -- agent-flow.workflow.spec.ts
pnpm --filter ./apps/api test -- agent-flow.activities.spec.ts
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check
```

**完成标准：** 独立 worker 可运行最小 Flow；重启 worker 后 Workflow 不丢失等待审批状态；Temporal History 不含完整聊天内容、密钥或 MCP 原始结果。

## 阶段 5：StreamTask 接入、SSE 和任务恢复

**目的：** 保持客户端入口不变，将已发布 AgentFlow 的执行从进程内 producer 切换为 Temporal，同时维持 SSE 回放和会话 trace。

**涉及文件：**

- 修改：`apps/api/prisma/schema.prisma`
- 修改：`apps/api/src/modules/stream-task/stream-task.service.ts`
- 修改：`apps/api/src/modules/stream-task/stream-task.module.ts`
- 修改：`apps/api/src/modules/stream-task/stream-task.controller.ts`
- 修改：`apps/api/src/modules/conversation-trace/conversation-trace.mapper.ts`
- 修改：`packages/types/src/protocol/events.ts`
- 修改：`packages/types/src/protocol/payloads.ts`
- 修改：`packages/types/src/protocol/factory.ts`
- 新建：`apps/api/src/modules/stream-task/flow-task-dispatcher.service.ts`
- 新建：`apps/api/src/modules/stream-task/flow-task-dispatcher.spec.ts`
- 新建：`apps/api/src/modules/agent-flow/temporal/agent-flow-signal-outbox.service.ts`
- 新建：`apps/api/src/modules/agent-flow/temporal/agent-flow-signal-outbox.spec.ts`
- 修改：`apps/api/src/modules/agent-flow/agent-flow-approval.service.ts`
- 新建：`apps/api/src/modules/agent-flow/agent-flow-approval.service.spec.ts`

**工作项：**

1. `StreamTask` 创建时解析 Agent 的已发布 FlowVersion，在同一业务事务中锁定 `flowVersionId`、`flowDigest` 和初始 nodeKey。
2. `FlowTaskDispatcher` 启动 Temporal Workflow；成功后 API 只订阅/回放事件，不在 SSE 请求内执行模型。
3. Activity 在 PostgreSQL 事务内分配语义 `eventId`、更新 `StreamTask` 并创建 `StreamTaskEvent`；事务提交后才追加 Redis 帧。客户端重放游标继续使用 Redis Stream ID（`Last-Event-ID`/`cursor`），它不同于数据库的 `StreamTask.lastEventId`。
4. 审批 Activity 在进入等待前以事务和稳定 `approvalId` 创建 `AgentFlowApproval(PENDING)`、`ConversationTurnTraceItem(APPROVAL, RUNNING)`、审批请求事件并更新 `StreamTask.status=WAITING_HUMAN`；审批 API 以条件更新锁定待处理审批，在同一事务持久化决定、收敛 trace、写 resolved 事件和 `AgentFlowSignalOutbox`。outbox 派发器只向 Temporal 发送 `approvalId`，恢复 Activity 从 `AgentFlowApproval` 读取决定。相同 `taskId + approvalId` 的同一决定返回既有结果，不同决定返回冲突。
5. 新 Flow 发送 `flow.*` 协议事件，旧策略任务继续发送既有事件直到旧任务自然完成；trace mapper 依据新事件创建 Flow node trace。此阶段只允许 admin 测试会话运行 Flow，普通用户聊天必须等待移动端与 admin 测试台消费 `flow.*` 事件后再启用。
6. Workflow 的超时、取消与恢复失败经 Activity 幂等收敛审批与 trace：有效的人为决定为 `SUCCESS`，超时、取消与异常为 `ERROR`。人工恢复或重新派发创建新的 `StreamTaskRun`；内部 Activity retry 使用同一 node execution 的 attempt 记录，不机械新增可见 run。
7. 增加 HTTP 集成测试：创建任务、断线回放、计划审批、工具审批、取消、worker 重启后的恢复；覆盖重复审批请求、outbox 在 API 崩溃后的 Signal 派发重试、Signal 不含审批决定正文，以及 `flow.waiting_human` 仍能驱动现有审批卡片。

**验证：**

```bash
pnpm --filter ./apps/api test -- flow-task-dispatcher.spec.ts
pnpm --filter ./apps/api test:e2e
pnpm --filter ./apps/api run build
node apps/api/scripts/debug-hitl.cjs
node apps/api/scripts/debug-plan-graph.cjs
```

**完成标准：** 已启用 Flow 的 Agent 不依赖 HTTP 进程存活；客户端无需更换首次聊天与续流协议；审批、取消和 SSE 回放均按锁定 FlowVersion 工作。worker 重启、重复审批请求或 Signal 重试不得创建重复审批 trace；每条审批 trace 都能与对应的 `StreamTaskEvent` 和 `StreamTask.status` 对齐。

## 阶段 6：预设迁移、灰度与清理

**目的：** 将 Direct、ReAct、PlanExecute、Hybrid 迁移为内置 Flow，并删除新任务对策略注册表的依赖。

**涉及文件：**

- 修改：`apps/api/prisma/seed.ts`
- 修改：`apps/api/src/modules/agent/agent-definition.service.ts`
- 修改：`apps/api/src/modules/ai/agent-loop/strategy-router.service.ts`
- 修改：`apps/api/src/modules/ai/agent-loop/strategy-registry.service.ts`
- 修改：`apps/api/src/modules/ai/agent-loop/graphs/plan-execute.graph.ts`
- 修改：`apps/api/src/modules/ai/agent-loop/graphs/hybrid-plan-react.graph.ts`
- 修改：`apps/api/docs/agent-chat-chain.md`
- 修改：`apps/api/docs/agent-loop-evolution.md`
- 修改：`apps/api/docs/hitl.md`
- 修改：`apps/api/scripts/debug-agent.cjs`
- 修改：`apps/api/scripts/debug-router.cjs`
- 修改：`apps/api/scripts/debug-hitl.cjs`
- 修改：`apps/api/scripts/debug-plan-graph.cjs`
- 修改：`apps/mobile/src/services/stream/stream-event.types.ts`
- 修改：`apps/mobile/src/services/stream/stream-event.helpers.ts`
- 修改：`apps/mobile/src/utils/streamFeedback.ts`
- 修改：`apps/admin/src/pages/agent-test.tsx`

**工作项：**

1. seed 四个内置只读 Flow，并显式标注模板来源和 schemaVersion；管理员可克隆模板生成可编辑 Flow，但不能编辑内置版本。
2. 先让移动端与 admin 测试台从 `@litter-bear/types/protocol` 消费并展示 `flow.*` 事件；补齐对应单测后，再对一个非默认测试 Agent 开启 Flow dispatch feature flag。
3. 先灰度 Direct 和 ReAct；观测错误率、时延、重试率、SSE 回放和 trace 完整性。
4. 灰度 PlanExecute 与 Hybrid，覆盖计划审批、工具审批、多轮恢复、MCP 用户凭据锁定和外部写工具幂等。
5. 当所有新 Agent 都经发布 Flow 执行后，删除新任务进入 `StrategyRegistryService` 的路径和仅为新任务存在的策略配置字段；旧任务继续按锁定策略运行至终态，再按既有保留策略清理，不能仅以 SSE 缓冲或审批 TTL 作为删除依据。
6. 更新运行手册：worker 告警、卡住任务、审批超时、Temporal History 定位、Flow 回滚与外部副作用 `UNKNOWN` 的人工处理步骤。

**验证：**

```bash
pnpm --filter ./apps/api test
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check
pnpm --filter ./apps/mobile run typecheck
pnpm --filter ./apps/mobile run build:weapp
```

**完成标准：** 四个预设 Flow 覆盖现有策略；生产新任务只有一个主执行路径；任何失败都能在 admin、Temporal 和 `ConversationTurnTraceItem` 中关联到 task、FlowVersion、node 和 worker attempt。

## 发布与回滚规则

- 发布 FlowVersion 前必须通过 JSON 结构校验、能力闭集校验、草稿测试和全量后端构建。
- 首次发布仅绑定测试 Agent；指标稳定后再切换默认 Agent。
- 回滚只切换 `AgentFlow.publishedVersionId`，不会终止已启动的任务；已启动任务继续锁定原版本。
- 检测到外部副作用不确定时，停止自动重试，标记任务错误并在 admin 提供人工核对信息。
- 禁止通过修改已发布 Definition、重写 Temporal History 或手工更新 `StreamTask.executionState` 修复线上任务。

## 最终验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| 导入相同 JSON，layout 不同 | 语义 digest 相同，仍创建独立草稿 |
| 草稿引用未知工具组 | 发布拒绝，错误精确到节点字段 |
| worker 在审批期间重启 | Workflow 等待状态保留，Signal 后从原 checkpoint 恢复 |
| worker 在外部写工具前后重启 | 使用同一 idempotencyKey；无法确认时进入 `UNKNOWN` |
| 管理员发布新版本 | 旧运行任务不受影响，新任务锁定新版本 |
| SSE 断线 | 客户端按 Redis Stream ID（`Last-Event-ID`/`cursor`）回放，不重复帧；数据库语义 `lastEventId` 保持独立 |
| Hybrid 提前结束 | 不执行未必要步骤，仍调用一次 synthesize |
| 计划审批拒绝终止 | 不调用工具或 synthesize，返回明确终止事件 |
| 非管理员访问 Flow API | 返回权限错误，不泄露 FlowDefinition |
