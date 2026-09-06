# Agent、模型预设与 Flow 模型归属设计

**日期：** 2026-09-04  
**状态：** 设计已确认，待实现  
**范围：** 收敛 Agent、模型预设和 FlowVersion 的模型决策边界；支持终端在 Agent 允许集合内为单条消息选择模型；移除无效的任意模型覆盖；让全部 Flow 内模型调用由节点配置决定。  
**不包含：** 终端模型选择 UI、通用 Flow 参数系统、按会话继承模型、模型自动故障切换、覆盖 Flow 显式模型、请求级生成参数调整、旧 Flow 工件兼容层。

## 背景

AgentFlow 已是聊天的唯一执行路径：Agent 绑定已发布 FlowVersion 时执行该版本，未绑定时执行系统内置 direct Flow。现有界面和接口仍保留了旧编排时期的多套模型入口，导致职责看起来互相覆盖：

- Agent 表单可以选择 `modelPreset`。
- Flow 的 `agent`、`plan-loop.executor` 和 `synthesize` 节点可以选择模型。
- Admin 调试聊天可以临时选择任意模型预设。
- 普通聊天 DTO 仍接受 `modelId/provider/platform/model` 和生成参数。

真实运行时并没有按这些入口共同决策。Temporal Activity 编译 Flow 时只读取 Agent 的 `modelPreset` 来解析 `agent-default`，完全不读取 Admin 调试或普通聊天写入 `requestPayload.llm` 的覆盖值。因此调试页的模型下拉框是无效入口，普通聊天的模型字段也是无效契约。

此外，任务创建阶段会把请求先解析成包含明文 API Key 的完整 LLM 配置，再写进 `StreamTask.requestPayload.llm`。Flow 不消费这份数据，但历史任务仍可能保留密钥。该持久化路径必须删除，并提供一次性历史清理工具。

Flow 内部也尚未完全实现“模型归 Flow”：

- `plan` 节点没有模型字段，`PlannerService` 仍按代码内的 Kimi 平台选择模型。
- `approval(policy="model")` 的模型判定使用系统默认模型，不能由节点配置。

本次改造要让每个模型决策只有一个明确来源，同时保留“同一 Flow 被多个 Agent 复用并使用不同模型”的能力。

## 目标

- FlowVersion 是 Agent 聊天的唯一执行策略。
- Agent 提供 `agent-default` 的允许模型集合与默认值，不成为第二套编排器。
- 终端只能在 Agent 允许集合中为单条消息选择模型。
- 终端选择只解析 `agent-default`，永远不覆盖 Flow 显式模型。
- Admin 调试真实运行 Agent 当前配置，不拥有独立模型决策权。
- `plan` 和模型审批等 Flow 内模型调用也由节点模型配置决定。
- Temporal 重试读取任务创建时锁定的模型，不重新读取 Agent 当前默认值。
- 任务、日志、事件和历史节点输出不保存明文模型密钥。
- 系统默认模型与 Agent 默认模型在术语和 UI 上明确分离。

## 领域语言

### 供应商连接

保存 API 根地址和凭据。它不决定某个 Agent 或 Flow 使用哪个模型。

### 模型预设

表示一个可调用的具体模型配置，包含稳定的 `presetId`、上游模型名、协议、生成参数和能力档位。`ModelPreset.id` 是数据库内部主键；Flow、Agent 和终端契约使用不可变业务标识 `ModelPreset.presetId`。

### 系统默认模型

`ModelPreset.isDefault=true` 的预设。只供不属于任何 Agent Flow 的系统级模型任务使用，例如会话标题、会话摘要和群聊选人。Admin 模型预设页使用“系统默认模型”文案，不能简称为“默认模型”。

### Agent

表示身份、人设、访问权限和执行入口，并为 `agent-default` 提供允许模型集合与默认值。Agent 不直接执行 LLM，也不拥有独立于 Flow 的策略。

### FlowVersion

Agent 聊天的唯一执行策略，决定节点、边、工具、技能、预算及每个模型调用使用显式模型还是 `agent-default`。

### `agent-default`

Flow 暴露给 Agent 的受控模型参数位，不是模型预设、供应商模型 ID 或全局默认值。任务创建时解析一次，之后不可改变。

### 本轮选择模型

终端在发送单条消息时传入的 `selectedModelPresetId`。其值是 `ModelPreset.presetId`，必须属于当前 Agent 的允许集合。它只影响本轮任务中的 `agent-default`。

## 关系与唯一事实源

```txt
供应商连接
  保存 API 地址与凭据
        ↓
模型预设
  表示一个可调用模型
        ↓
Agent
  身份、人设、权限、执行入口
  + 允许模型集合
  + Agent 默认模型
        ↓
FlowVersion
  唯一执行策略
  + 显式模型
  + agent-default 参数位
        ↓
StreamTask
  锁定 FlowVersion
  + 锁定本轮 agent-default 的实际模型
```

Agent 的执行方式不新增数据库枚举。`defaultFlowVersionId = null` 继续是“执行系统内置 direct Flow”的唯一持久化事实，非空表示执行指定的已发布自定义 FlowVersion。Admin 表单用明确的“直接回复 / 自定义 Flow”分段控件呈现这一事实，不同时保存一个可能漂移的 `executionMode` 字段。

## Agent 模型策略

Agent 配置两个独立但有关联的值：

```txt
allowedModelPresets   允许模型预设集合
defaultModelPreset    Agent 默认模型，必须属于允许集合
```

不增加“允许终端选择模型”开关，允许集合本身就是唯一规则：

- 0 个：该 Agent 不提供 `agent-default`。
- 1 个：固定使用该模型，终端无需展示选择器。
- 2 个及以上：终端可以在集合中选择。

有效 Flow 使用 `agent-default` 时，允许集合必须非空且默认模型必填。有效 Flow 完全使用显式模型时，允许集合和默认模型必须为空，避免保存不会驱动执行的死配置。

direct Flow 固定包含 `agent-default`，因此 direct Agent 必须配置允许集合和默认模型。

## 单条消息的模型解析

选择按单条消息生效，不写入 Conversation，也不自动继承上一轮：

```txt
终端发送消息
  selectedModelPresetId?（可选）
        ↓
解析真实回答 Agent 与有效 FlowVersion
        ↓
判断 Flow 是否使用 agent-default
        ↓
校验 Agent 允许集合、预设和连接状态
        ↓
resolvedAgentModelPresetId = 本次选择 ?? Agent 默认模型
        ↓
与 FlowVersion 快照一起写入 StreamTask
        ↓
Temporal Activity 只读取任务快照
```

具体规则：

- 未传 `selectedModelPresetId` 时使用 Agent 默认模型。
- 传入值不属于允许集合时，在任务落库前拒绝。
- 模型预设或供应商连接已停用时，在任务落库前拒绝。
- Flow 不使用 `agent-default` 却传入选择值时拒绝，不静默忽略。
- Runtime Validator 继续按全部使用 `agent-default` 的节点验证模型能力。例如本轮选择的模型没有工具能力，而某个 `agent-default` 节点配置了工具组，则任务创建失败。
- Flow 显式模型节点不读取 `resolvedAgentModelPresetId`。
- 修改 Agent 默认模型或允许集合不改变已经创建的任务，也不改变 Temporal 对同一任务的重试结果。

`StreamTask` 只保存最终解析出的稳定预设标识，不保存完整 LLM 请求、连接 URL 或密钥。Activity 运行到具体模型调用前，才通过模型注册表解析预设并在内存中解密密钥。

## Flow 模型所有权

所有 Flow 内部模型调用都必须从节点配置取得模型：

| 节点                       | 模型来源                      |
| -------------------------- | ----------------------------- |
| `agent`                    | `config.modelPreset`          |
| `plan`                     | 新增 `config.modelPreset`     |
| `plan-loop`                | `config.executor.modelPreset` |
| `approval(policy="model")` | 新增 `config.modelPreset`     |
| `synthesize`               | `config.modelPreset`          |

以上字段使用同一规则：缺省或值为 `agent-default` 时解析任务锁定模型；其他值视为显式 `ModelPreset.presetId`。

`approval` 的 `always` 和 `never` 策略不调用模型，因此不允许携带 `modelPreset`。`model` 策略允许显式预设或 `agent-default`。结构校验和 Admin 节点检查器必须体现该条件关系。

`PlannerService` 不再导入或筛选 Kimi 平台，而是接收编译后 `plan` 节点的具体模型预设。计划审批门禁同样把编译后的模型预设传给 `LlmService.generateStructured`。结构化输出原有的解析与降级规则保持不变。

Flow Definition 当前 schemaVersion 是 7，因新增节点字段语义升到 8。项目不提供旧工件兼容运行时，现有 v7 Flow 需要基于新 schema 重新创建草稿并发布。内置 direct Flow 由 `BuiltinFlowService` 幂等生成 v8 发布版本。

本次不改变 `agent-flow.workflow.ts` 的 Activity、Timer 或等待命令序列，因此 `AGENT_FLOW_WORKFLOW_REVISION` 保持当前的 6。

## 数据模型

Agent 与模型预设使用规范化关联，不在 Agent 上保存无约束字符串数组：

```txt
Agent
  defaultModelPresetId   String?
  defaultModelPreset     ModelPreset?
  allowedModelPresets    AgentAllowedModelPreset[]

AgentAllowedModelPreset
  agentId                String
  modelPresetId          String
  @@unique([agentId, modelPresetId])

StreamTask
  resolvedAgentModelPresetId String?
```

关联表引用真实 ModelPreset 记录，默认模型也使用关系字段。服务层在同一事务中写入允许集合和默认模型，并校验默认项属于集合。

对外 DTO 仍使用稳定的 `presetId`，不暴露或要求终端保存数据库 cuid。具体 Prisma 字段可以使用内部主键建立外键，Service 负责在内部主键与稳定 `presetId` 之间映射；Flow Definition 继续只保存 `presetId`。

`StreamTask.resolvedAgentModelPresetId` 保存稳定 `presetId`，它是执行快照而不是 Agent 当前关系。模型预设删除引用检查必须覆盖未终结任务，防止任务等待或重试期间失去模型；已终结任务只保留标识用于审计，不永久阻止模型预设清理。

Prisma 迁移建议命名：

```txt
agent_model_selection_and_flow_model_ownership
```

现有 Agent 的模型字段已经在供应商连接迁移前清空，不做旧值转换。

## 后端契约

### 终端模型选项

新增认证接口：

```http
GET /agents/:agentId/models
```

响应为安全投影：

```json
{
  "agentId": "agent_xxx",
  "defaultModelPresetId": "deepseek-official:deepseek-chat",
  "models": [
    {
      "modelPresetId": "deepseek-official:deepseek-chat",
      "name": "DeepSeek Chat",
      "providerKey": "deepseek",
      "model": "deepseek-chat"
    }
  ]
}
```

接口校验的是 Agent 的可使用权限，不把 `visible` 当作使用权限。隐藏但当前用户有权使用的 Agent 仍可读取其模型选项。响应只包含 Agent 允许集合中当前已启用且连接可用的预设，不返回连接 ID、URL、能力探测错误、密钥提示或生成参数。

有效 Flow 不使用 `agent-default` 时返回空数组和 `defaultModelPresetId: null`。客户端可按模型数量决定 UI：0 或 1 个不展示切换器，2 个及以上展示选择器。

### 聊天请求

文本和语音聊天使用同一个受限字段：

```ts
selectedModelPresetId?: string;
```

删除聊天 DTO 中以下旧字段：

```txt
modelId
provider
platform
model
temperature
maxOutputTokens
topP
```

不保留双字段兼容层。终端 API 客户端需要按最新 OpenAPI 重新生成。

### Admin 调试请求

`AgentTestDto` 删除 `modelPreset`。Admin 调试页只选择 Agent 并运行其真实 Flow 与 Agent 默认模型，不模拟终端选择，也不允许从全局预设列表任意覆盖。模型预设自身的连通性和工具能力继续在模型预设页探测。

## Admin Agent 配置

Agent 表单的执行区改为：

1. 分段选择“直接回复”或“自定义 Flow”。
2. 直接回复固定使用只读的系统 direct Flow，不展示 Flow 下拉框。
3. 自定义 Flow 只列出已发布版本。
4. 有效 Flow 使用 `agent-default` 时，展示允许模型多选与默认模型单选。
5. 有效 Flow 不使用 `agent-default` 时，隐藏并清空两项模型配置。

默认模型下拉选项只能来自已勾选的允许集合。移除当前“留空且 Flow 使用该选项时运行时拒绝”的弱提示，改为保存前明确校验。

Agent 列表展示执行方式、Agent 默认模型和允许模型数量。Flow 显式模型不在 Agent 卡片重复展示。

判断 Definition 是否使用 `agent-default` 的纯函数必须成为共享实现，覆盖以下位置及“字段缺省等同于 `agent-default`”的规则：

- `agent.config.modelPreset`
- `plan.config.modelPreset`
- `plan-loop.config.executor.modelPreset`
- `approval(policy="model").config.modelPreset`
- `synthesize.config.modelPreset`

后端保存校验、任务快照解析和 Admin 表单不能各自手抄一份不同的遍历规则。

## 模型预设引用与状态

模型预设引用查询和删除护栏扩展到：

- Agent 默认模型关系。
- Agent 允许模型关系。
- Flow 的 `agent`、`plan`、`plan-loop.executor`、模型审批和 `synthesize` 节点。
- 引用该模型的未终结 StreamTask 快照。

模型或连接被停用后不自动替换为允许集合第一项，也不回退系统默认模型。Admin 应把受影响 Agent 显示为配置不可运行；新任务返回明确配置错误。已开始的上游调用不尝试强制取消，Temporal 后续重试仍按任务锁定标识解析，并在预设不可用时明确失败。

## 历史敏感载荷清理

新增一次性 Prisma 维护脚本 `apps/api/scripts/sanitize-stream-task-llm-payloads.cjs`，处理历史 `StreamTask.requestPayload.llm`：

- 默认只扫描并输出待清理任务数量。
- 只有传入显式 `--apply` 才执行更新。
- 逐条读取 JSON，通过结构化对象操作删除顶层 `llm` 字段，再写回其余载荷。
- 不使用手写 SQL，不修改 Prisma migration SQL。
- 不删除 StreamTask、消息、Flow 快照、麦当劳凭据标识或其他业务字段。
- 不打印原载荷、模型配置、URL 或密钥。
- 脚本可重复执行；已经没有 `llm` 的任务保持不变。

该脚本由用户在本地或目标环境手动执行。代码上线后新任务不再生成 `requestPayload.llm`。

```bash
# 只统计，不写数据库
node apps/api/scripts/sanitize-stream-task-llm-payloads.cjs

# 确认统计结果后执行清理
node apps/api/scripts/sanitize-stream-task-llm-payloads.cjs --apply
```

## 错误边界

以下错误在任务写入和 Temporal 派发之前返回：

- 有效 Flow 依赖 `agent-default`，但 Agent 没有允许集合或默认模型。
- Agent 默认模型不属于允许集合。
- `selectedModelPresetId` 不属于允许集合。
- 选择或默认的模型预设不存在、已停用或连接已停用。
- Flow 不使用 `agent-default` 却收到终端模型选择。
- 本轮解析模型不满足任一 `agent-default` 节点的工具能力要求。

以下错误在 Flow 发布时返回：

- `plan` 或模型审批引用不存在、停用的显式模型。
- `approval(always|never)` 携带无效的 `modelPreset`。

任何路径都不自动选择第一条预设，不把配置错误伪装成空回复或模型降级。

## 验证策略

### 后端单元与集成测试

- direct Agent 必须具有非空允许集合和默认模型。
- 自定义 Flow 使用及不使用 `agent-default` 的两类 Agent 保存校验。
- 默认模型必须属于允许集合。
- 允许集合关系的新增、更新、删除及引用护栏。
- 终端模型接口的使用权限、可用状态过滤和安全响应字段。
- 合法选择覆盖全部 `agent-default` 节点，但不覆盖显式模型节点。
- 非允许、停用和连接不可用模型在任务创建前失败。
- 修改 Agent 配置后，已创建任务和 Temporal Activity 重试仍读取任务快照。
- `plan`、模型审批、`agent`、`plan-loop` 和 `synthesize` 的统一编译结果。
- Planner 不再按 Kimi 平台筛选，模型审批使用节点模型。
- `requestPayload` 不包含 `llm`、`apiKey` 或完整连接配置。
- Admin 调试 DTO 不接受模型覆盖。
- 历史清理脚本的 dry-run、apply、幂等和字段保留行为。

### 前端与契约验证

- Admin Agent 表单两种执行方式的字段显隐和保存校验。
- 多选集合变化后默认模型的约束。
- Admin 调试页不再出现模型选择。
- 手写 Admin DTO 与后端响应同步。
- OpenAPI 与移动端生成客户端包含 `selectedModelPresetId` 和终端模型接口，不再包含旧任意模型字段。

### 必跑命令

```bash
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check
npx jest --testPathIgnorePatterns "workflows/agent-flow.workflow.spec"
npx jest src/temporal/workflows/agent-flow.workflow
pnpm --filter ./apps/admin run typecheck
pnpm --filter ./apps/admin run lint
pnpm --filter ./apps/admin run build
pnpm --filter ./apps/mobile run typecheck
pnpm build
```

Temporal 集成套件按 `apps/api/AGENTS.md` 的约定，以输出中的 Jest suite/test 汇总判断，不以尾部连接拒绝或进程退出码单独判断结果。

## 发布与验收顺序

1. 完成 Prisma schema、后端契约、Flow schemaVersion 8 和 Admin 改造。
2. 用户执行迁移 `agent_model_selection_and_flow_model_ownership`。
3. 用户先以 dry-run 执行历史任务载荷清理，确认数量后带 `--apply` 清理。
4. 重启 API、Temporal 编排 Worker 和 Activity Worker。
5. 创建或确认可用的模型预设与系统默认模型。
6. 为 direct 或使用 `agent-default` 的 Agent 配置允许集合和 Agent 默认模型。
7. 基于 schemaVersion 8 重建并发布自定义 Flow。
8. 验收 direct、显式模型 Flow、可选模型 Flow、Admin 调试和 Temporal 重试。

## 已接受代价

- 现有 schemaVersion 7 Flow 工件不兼容，必须重建并重新发布。
- 迁移后尚未配置模型集合的 direct Agent 会明确拒绝聊天。
- 终端必须重新生成 API 客户端；本次不实现终端模型选择 UI。
- 每次聊天任务创建增加 Agent 模型关系和有效 Flow 模型需求校验。
- 系统默认模型与 Agent 默认模型需要分别配置；任何一方缺失都不会互相兜底。
