# 模型思考配置与上下文连续性设计

**日期：** 2026-09-05
**状态：** 设计已确认，待书面复核
**范围：** 明确 Agent、Flow、模型预设与本轮模型选择的职责；提供代码内置的供应商模型能力目录；为 direct Agent 和自定义 Flow 增加模型级思考配置；保存供应商要求回传的隐藏模型上下文；补充热门模型模板、供应商 Logo 和准确的连接统计。
**不包含：** 自定义 Flow 的请求级模型覆盖、群聊自动路由时提前选择模型、跨供应商自动故障切换、允许管理员自行声明模型能力、旧 Flow 工件兼容层、自动覆盖现有连接或模型预设、自动删除空连接、系统级标题和摘要模型的思考设置。

## 与既有设计的关系

本文是 [AgentFlow 模型归属设计](./2026-09-04-agent-flow-model-ownership-design.md) 的增量修订。旧设计中的模型预设业务标识、发布版本不可变、任务快照以及 Admin 调试不拥有模型覆盖权等安全边界继续有效，以下规则由本文覆盖：

1. `agent-default` 只允许系统内置 direct Flow 使用。自定义 Flow 的每个真实 LLM 节点都必须引用具体 `ModelPreset.presetId`。
2. direct Agent 允许终端按本轮从 Agent 允许集合中选择模型和思考配置；自定义 Flow Agent 不开放请求级覆盖。
3. 思考能力不再使用 `effort | toggle | fixed | none` 四选一模式，而是使用可组合的开关、强度、预算、约束和上下文策略。
4. 模型能力来自代码目录，不进入 `ModelPreset` 可编辑字段。

Flow Definition 只保存模型预设业务标识和供应商无关的思考选择，不保存 URL、密钥或厂商请求字段。Provider 层负责把统一选择映射成上游协议，因此 Flow 与具体 LLM SDK 不形成代码级绑定。

## 背景

模型管理已拆成“供应商连接”和“模型预设”：

- `ModelProviderConnection` 保存供应商模板、`baseURL`、密钥、启停状态和连通性状态。
- `ModelPreset` 保存具体模型 ID、上游协议和生成参数。
- 一条连接可以关联多个模型预设；删除模型不会删除连接。

当前仍有四类问题：

- Agent、Flow 节点、Admin 调试和终端都可能出现模型入口，执行时的最终决定权不够明确。
- 不同模型可能同时支持思考开关和强度、开关和 token 预算，单一思考模式无法表达官方能力。
- Temporal 重试、重连和 HITL 恢复必须固定使用任务创建时的最终模型与思考设置。
- 多家供应商要求在工具往返或后续对话中原样回传隐藏推理、签名和工具上下文；这些数据又不能进入 SSE、Trace、Flow 输出或客户端状态。

## 目标

- 每个真实 LLM 调用点都得到已经过模型能力校验的“模型预设 + 思考选择”。
- direct Agent、自定义 Flow、Admin 调试和终端各自只有一个明确的模型决策入口。
- 思考设置严格来自官方能力目录，不根据模型名称猜测，不静默丢弃非法字段。
- 模型与思考选择在创建 `StreamTask` 时固化，任务恢复不重新读取 Agent 当前默认值。
- 支持 OpenAI、Anthropic、DeepSeek、豆包、Kimi、Google Gemini、通义千问、智谱 GLM 和 MiniMax 的推荐模型目录。
- 推荐模型只用于快速添加，不覆盖现有连接和模型数据。
- 保存后续调用必需的最小隐藏上下文，同时不扩大外部暴露面。

## 领域边界

### 供应商连接

`ModelProviderConnection` 是一组可复用的连接信息。`providerKey` 指向代码内置供应商模板，一条连接可挂多个模型预设。删除某个模型预设不级联删除连接；空连接只能由管理员显式删除。

供应商模板负责默认根地址、允许的上游协议、推荐模型列表，以及 Admin 中的名称和工程内 Logo 映射。模板不创建连接、不写入密钥，也不覆盖数据库中的同名记录。

### 模型预设

`ModelPreset` 是 Agent 或 Flow 引用的具体模型配置，拥有稳定的 `presetId`、精确上游模型 ID、上游协议及生成参数。模型预设不自行声明思考能力；服务端使用 `providerKey + upstreamFormat + model` 精确查询代码目录。

管理员可以手填目录之外的模型 ID。未知模型仍可作为普通模型调用，但不开放思考设置；若 Agent、Flow 或聊天请求为未知模型携带 `reasoning`，后端明确拒绝。

### Agent

Agent 表示身份、人设、访问权限和执行入口：

- `defaultFlowVersionId = null` 表示执行系统内置 direct Flow。此时 Agent 保存允许模型集合、默认模型和该默认模型的默认思考选择。
- `defaultFlowVersionId != null` 表示执行已发布的自定义 FlowVersion。此时 Agent 不保存 direct 专属模型配置，实际模型由 Flow 的各 LLM 节点决定。

“指定模型直接回答”仍通过内置 direct Flow 执行，不新增第二条直接调用 LLM 的路径。

### FlowVersion

自定义 FlowVersion 是不可变执行策略。每个真实 LLM 节点独立引用具体模型预设，并保存该模型支持的思考选择。自定义 Flow 不读取 Agent 默认模型，也不接受终端覆盖节点模型。

### 本轮终端选择

终端仅可为 direct Agent 的单条消息提交模型和思考选择。模型必须属于 Agent 允许集合，思考选择必须属于所选精确模型的官方能力范围。选择只对本任务生效，不写入 Conversation。

客户端可以按 Agent 在本机记住最近选择，但每条消息都必须提交本轮最终值，服务端重新校验。

### 系统级模型任务

会话标题、摘要、群聊自动选人等系统任务继续使用系统默认模型。它们不读取 Agent 默认设置或终端选择，是否开放思考配置不在本次范围内。

## 模型目录策略

### 模型 ID 版本策略

推荐模型采用混合策略：

- 官方提供稳定且能力契约明确的别名时使用稳定别名。
- 仅提供日期版本，或稳定别名可能改变能力矩阵时，固定具体版本 ID。
- 豆包等以日期 ID 发布的模型保留日期段。
- 目录升级不会修改已存在的 `ModelPreset.model`。

模型目录是代码版本的一部分。FlowVersion 和 StreamTask 仍保存具体模型预设引用及解析后的思考选择，使已经创建的任务不随 Agent 默认值变化。

### 可组合能力模型

统一的用户选择结构：

```ts
type ReasoningActivation = 'enabled' | 'disabled' | 'auto';

type ReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

type ReasoningSelection = {
  activation?: ReasoningActivation;
  effort?: ReasoningEffort;
  budgetTokens?: number | 'auto';
};

type PersistedReasoningConfig = {
  version: 1;
  selection: ReasoningSelection;
};
```

能力目录描述模型真正支持的控制项：

```ts
type ModelReasoningCapability = {
  activation?: {
    values: readonly ReasoningActivation[];
    defaultValue: ReasoningActivation;
    configurable: boolean;
  };
  effort?: {
    values: readonly ReasoningEffort[];
    defaultValue: ReasoningEffort;
    configurable: boolean;
  };
  budget?: {
    minimum: number;
    maximum: number | { lessThanGenerationField: 'maxOutputTokens' };
    defaultValue: number | 'auto';
    configurable: boolean;
  };
  constraints: readonly ReasoningConstraint[];
  generationPolicy: ModelGenerationPolicy;
  requestMapping: ModelReasoningRequestMapping;
  contextPolicy: ModelContextPolicy;
};
```

规则如下：

- 控制项可以组合，不再四选一。
- `configurable: false` 表示固定能力，Admin 只读展示，Agent 和 Flow 不保存对应选择。
- UI 只展示会产生真实行为差异的值。上游虽然接受但会映射为同一档位的兼容值不对用户展示。
- `activation = disabled` 时不得残留 `effort` 或 `budgetTokens`。
- 预算只有在目录能给出完整校验边界时才开放数值输入；目录不能验证上限的模型仅使用官方自动预算，不伪造范围。
- sampling 参数限制独立放在 `generationPolicy`，不能把 `temperature` 或 `topP` 当作思考强度。
- `requestMapping` 仅在服务端使用，不进入前端 DTO。
- `contextPolicy` 决定隐藏上下文的采集和回放，不由客户端控制。

### 推荐模型与能力矩阵

资料核对基线为 2026-09-05。

| 供应商模板 | 推荐模型 | 用户可见思考能力 | 默认值 |
|---|---|---|---|
| OpenAI | `gpt-5.6-sol` | 暂不开放 | 无 |
| OpenAI | `gpt-5.6-terra` | 暂不开放 | 无 |
| OpenAI | `gpt-5.6-luna` | 暂不开放 | 无 |
| Anthropic | `claude-fable-5-1` | 固定开启 + `low/medium/high/xhigh/max` | `high` |
| Anthropic | `claude-opus-5` | 开启/关闭 + `low/medium/high/xhigh/max` | 开启 + `high` |
| Anthropic | `claude-sonnet-5` | 开启/关闭 + `low/medium/high/xhigh/max` | 开启 + `high` |
| Anthropic | `claude-haiku-4-5` | 开启/关闭 + token 预算 | 开启 + 自动预算 |
| DeepSeek | `deepseek-v4-pro` | 开启/关闭 + `low/high/max` | 开启 + `high` |
| DeepSeek | `deepseek-v4-flash` | 开启/关闭 + `low/high/max` | 开启 + `high` |
| 豆包 | `doubao-seed-evolving` | 开启/关闭 + `low/medium/high` | 开启 + `high` |
| 豆包 | `doubao-seed-2-1-pro-260628` | 开启/关闭 + `low/medium/high` | 开启 + `high` |
| 豆包 | `doubao-seed-2-1-turbo-260628` | 开启/关闭 + `low/medium/high` | 开启 + `high` |
| Kimi API | `kimi-k3` | `low/high/max` | `max` |
| Kimi API | `kimi-k2.7-code` | 固定思考 | 固定 |
| Kimi API | `kimi-k2.7-code-highspeed` | 固定思考 | 固定 |
| Kimi API | `kimi-k2.6` | 开启/关闭 | 开启 |
| Kimi Coding Plan | `k3` | `low/high/max` | `high` |
| Kimi Coding Plan | `k3-256k` | `low/high/max` | `high` |
| Kimi Coding Plan | `kimi-for-coding` | 固定思考 | 固定 |
| Kimi Coding Plan | `kimi-for-coding-highspeed` | 固定思考 | 固定 |
| Google Gemini | `gemini-3-pro-preview` | `low/high` | `high` |
| Google Gemini | `gemini-3-flash-preview` | `minimal/low/medium/high` | `high` |
| Google Gemini | `gemini-2.5-pro` | token 预算，不可关闭 | 自动预算 |
| Google Gemini | `gemini-2.5-flash` | 开启/关闭 + token 预算 | 自动预算 |
| 通义千问 | `qwen3.8-max` | 开启/关闭 + token 预算 | 开启 + 自动预算 |
| 通义千问 | `qwen3.8-flash` | 开启/关闭 + token 预算 | 开启 + 自动预算 |
| 通义千问 | `qwen3.7-plus` | 开启/关闭 + token 预算 | 开启 + 自动预算 |
| 智谱 GLM | `glm-5.3` | 固定开启 + `low/high/max` | `max` |
| 智谱 GLM | `glm-5.3-flash` | 固定开启 + `low/high/max` | `max` |
| MiniMax | `MiniMax-M3` | 开启/关闭 | 开启 |
| MiniMax | `MiniMax-M2.7` | 固定思考 | 固定 |
| MiniMax | `MiniMax-M2.7-highspeed` | 固定思考 | 固定 |

矩阵补充规则：

- `kimi-k3` 在 Admin 中显示为“Kimi K3（1M）”；上游请求仍使用官方模型 ID `kimi-k3`，展示名不参与调用。
- 豆包的 `none` 等价于 `minimal`，`xhigh/max` 等价于 `high`，因此界面只展示关闭和三个真实档位。
- MiniMax M3 的 `minimal/low/medium/high` 只表示开启，不代表不同深度，因此界面只展示开关。
- Anthropic 在关闭思考时不保存或发送 effort。Haiku 的手动预算必须小于 `maxOutputTokens`。
- Gemini 3 使用离散 thinking level；Gemini 2.5 使用 token budget。Gemini 2.5 Pro 的正数预算最小为 128，且不能用 0 关闭。
- 通义千问官方公共文档未给出所有模型的静态预算上限，首版提供开启、关闭和自动预算；仅当目录录入可验证的模型级范围后显示手动预算输入。
- OpenAI 官方页面在本次核对时返回 Forbidden。模型名称来自 `openai-docs` 的非权威本地 fallback，因此可以作为推荐模板，但本次不为其声明或发送思考参数。

OpenRouter 与自定义 OpenAI 兼容服务继续保留。它们不按代理后的模型名猜供应商能力，管理员手填模型默认不显示思考控件。

## 配置与持久化

### 数据库

只修改 `apps/api/prisma/schema.prisma`，不手写或编辑迁移 SQL：

```txt
Agent
  defaultReasoningConfig Json?

StreamTask
  resolvedAgentReasoningConfig Json?

Message
  modelContext Json?

ModelUpstreamFormat
  GEMINI_GENERATE_CONTENT

LlmUpstreamFormat
  gemini_generate_content
```

- `Agent.defaultReasoningConfig` 只属于 direct Agent 的默认模型。
- `StreamTask.resolvedAgentReasoningConfig` 保存本任务解析完成的最终选择。
- `Message.modelContext` 保存后续同模型调用需要但不向用户展示的上下文。
- Agent 和 StreamTask 的 JSON 保存 `PersistedReasoningConfig`，DTO 与 Flow 节点仍使用不带持久化版本号的 `ReasoningSelection`。
- 三个 JSON 字段在写入和读取时均使用版本化严格 Zod schema，拒绝额外字段。
- 模型能力不存入数据库，避免管理员伪造能力或目录更新后产生两份事实源。

建议迁移名：`add_model_reasoning_and_context`。

### Flow Definition

真实 LLM 节点统一保存：

```ts
{
  modelPreset: string;
  reasoning?: ReasoningSelection;
}
```

| 节点 | 模型字段 | 思考字段 |
|---|---|---|
| `agent` | `config.modelPreset` | `config.reasoning?` |
| `plan` | `config.modelPreset` | `config.reasoning?` |
| `plan-loop` | `config.executor.modelPreset` | `config.executor.reasoning?` |
| `approval(policy="model")` | `config.modelPreset` | `config.reasoning?` |
| `synthesize` | `config.modelPreset` | `config.reasoning?` |

保存和发布规则：

- 自定义 Flow 必须引用具体 `ModelPreset.presetId`，禁止 `agent-default`。
- 支持可调思考的模型必须显式保存完整选择，包括目录默认值，保证 FlowVersion 可复现。
- 固定思考或不支持思考的模型不得保存 `reasoning`。
- 关闭思考时不得残留 effort 或预算。
- 更换模型时先清除旧模型配置，再写入新模型的目录默认选择。
- `approval` 的 `always`、`never` 不调用模型，不得保存模型或思考设置。
- 发布时校验模型预设存在、启用、连接启用、节点能力满足且生成参数合法。

Flow Definition schema version 从 `8` 升到 `9`。不提供 v8 运行时兼容层，现有 v8 工件需要重建草稿并重新发布。

若实现只改变 Activity 输入、模型请求和持久化内容，不改变 Workflow 命令序列，则 `AGENT_FLOW_WORKFLOW_REVISION` 保持 `6`。实现时若实际修改命令序列，必须按常量文件说明递增并登记。

## 运行时解析

### direct Agent

```txt
终端提交 selectedModelPresetId? + reasoning?
        ↓
确认回答 Agent 使用内置 direct Flow
        ↓
selectedModelPresetId ?? Agent.defaultModelPresetId
        ↓
校验模型属于 Agent 允许集合，且模型预设与连接可用
        ↓
按 providerKey + upstreamFormat + model 查询能力目录
        ↓
请求 reasoning
  ?? 所选模型是 Agent 默认模型时的 Agent 默认 reasoning
  ?? 所选模型的目录默认值
        ↓
规范化并校验思考组合与生成参数
        ↓
将最终模型和 reasoning 写入 StreamTask
        ↓
内置 direct Flow 的 agent-default 只读取任务快照
```

校验必须在任务落库和 Temporal 派发前完成。Agent 默认思考设置只属于 Agent 默认模型；终端选择其他模型并省略 `reasoning` 时，使用所选模型的目录默认值，不能复用 Agent 默认模型的配置。

修改 Agent 默认值、允许集合或能力目录不改变已创建任务。Temporal Activity retry、重连和 HITL 恢复只读取 StreamTask 中的最终快照。

### 自定义 Flow Agent

终端不提交模型或 `reasoning`。编译器按每个节点的具体 `presetId` 解析模型，并使用已发布 Definition 中的思考选择。运行时保留防御性校验，避免绕过发布入口的非法工件执行。

### 统一模型请求

`ResolvedLlmTextRequest` 增加已经规范化的 `reasoning`。现有 `platform` 字段继续承载连接的 `providerKey`；业务节点不得拼接厂商字段，客户端不得提交 `modelKwargs`、`extra_body` 或其他任意透传 JSON。

```txt
ModelPreset + ReasoningSelection
        ↓
LlmModelRegistryService 精确匹配目录并校验
        ↓
ResolvedLlmTextRequest
        ↓
LlmChatModelFactory 按 requestMapping 生成厂商参数
```

## Provider 请求映射

| 厂商 | 上游字段 |
|---|---|
| Anthropic | `thinking` + `output_config.effort`；Haiku 使用 `budget_tokens` |
| DeepSeek | Chat 使用 `thinking.type` + `reasoning_effort` |
| 豆包 | `thinking.type` + `reasoning_effort` |
| Kimi | K3 使用 `reasoning_effort`；K2.6 使用 `thinking.type` |
| Gemini | 原生 `thinkingConfig.thinkingLevel` 或 `thinkingConfig.thinkingBudget` |
| 通义千问 | `enable_thinking` + `thinking_budget` |
| 智谱 GLM | `reasoning_effort`，禁止关闭思考 |
| MiniMax | M3 使用 `thinking.type`；M2.7 不发送可调字段 |
| OpenAI | 本次不发送思考字段 |

当前 LangChain 版本可以承载 OpenAI reasoning 和 Anthropic `thinking/outputConfig`。OpenAI 兼容供应商的非标准字段通过服务端生成的受控 `modelKwargs` 发送，不能接受请求侧任意 JSON。

Gemini 新增 `GEMINI_GENERATE_CONTENT` 上游格式，并接入原生 Gemini LangChain 客户端。官方思考设置和 `thoughtSignature` 属于 `generateContent` 语义；将其伪装为普通 OpenAI Chat 无法可靠保证参数和工具签名完整往返。这是本次唯一必要新增的 Provider 依赖。

调用前再次断言能力和生成参数组合：

- 关闭思考时拒绝残留 effort 或预算。
- Anthropic 开启思考时拒绝不兼容的 `temperature/topP`。
- Kimi K3、K2.6 和 K2.7 拒绝官方不支持的采样配置。
- DeepSeek 开启思考时拒绝保存实际会被上游忽略的采样参数。
- 任何无法映射的组合明确失败，不静默丢字段、不改成其他档位。

## 隐藏模型上下文

### 持久化信封

`Message.modelContext` 使用按策略判别的版本化信封：

```ts
type ModelContextEnvelope = {
  version: 1;
  providerKey: string;
  upstreamFormat: LlmUpstreamFormat;
  model: string;
  reasoningFingerprint: string;
  policy:
    | 'assistant-reasoning'
    | 'full-tool-transcript'
    | 'thought-signature';
  payload: ProviderModelContext;
};
```

`payload` 不是任意 JSON，而是严格 Zod 判别联合：

- Gemini 保存必须原样回传的 `thoughtSignature`。
- Anthropic 保存 thinking、signature、redacted thinking 和相关工具内容块。
- DeepSeek、豆包、Kimi、通义千问、GLM、MiniMax 保存目录策略要求的 `reasoning_content`、assistant tool calls 与对应 tool results。
- 不需要隐藏上下文的模型不写 `modelContext`。

不得保存 API Key、连接 URL、系统提示词或会话中已经存在的重复用户消息。

### 采集与回放

- CommonChatAgent 从原始 AI/tool 消息采集上下文，不新增公共流事件。
- 普通执行从当前有序消息流收集完整上下文。
- HITL 等待期间由现有 PostgreSQL checkpointer 保存图状态；恢复并完成后从最终状态重建完整上下文，避免丢失中断前的 thinking 和 tool call。
- 只有最终产生用户可见答案的节点将上下文写入该助手 `Message`。中间 Flow 节点不把供应商私有数据放进节点 `outputs`。
- 后续调用只有在目录判定 `providerKey + upstreamFormat + model + reasoningFingerprint` 兼容时才回放隐藏上下文。
- 切换模型或不兼容的思考配置时，只使用正常可见会话消息，并给客户端非阻断的“建议新建会话”提示。
- 上下文提取或校验失败不触发模型或工具重试，避免已经执行的工具重复发生。本轮答案仍正常完成，仅记录不含正文的安全告警，后续退回普通可见消息上下文。

### 隔离边界

`modelContext` 不进入：

- 会话和消息 REST DTO。
- SSE 事件与流式累计正文。
- AgentFlow 节点输出和 `$ref`。
- Trace、审计记录与错误日志正文。
- Admin 调试响应。
- 小程序 Zustand 状态和本地缓存。

遥测可以在内存中统计隐藏上下文 token，但日志只能记录 schema 版本、providerKey、model、策略、消息数量和是否成功，不得记录正文。解析异常信息不得拼接原始 payload。

## 接口与 UI

### 接口契约

- `GET /agents/:id/models` 继续作为终端模型选项入口。每个模型返回 `reasoningCapability` 安全投影，并返回 Agent 的 `defaultReasoning`。
- 自定义 Flow Agent 的模型选项响应为空数组，默认模型和默认思考选择均为空。
- 文本和语音聊天 DTO 在现有 `selectedModelPresetId` 外增加嵌套 `reasoning?: ReasoningSelection`。
- Agent 管理 DTO 增加 `defaultReasoning?: ReasoningSelection`。
- Admin 的供应商模板、推荐模型和模型预设响应返回能力及生成参数限制的只读投影，前端不复制官方矩阵。
- 后端 DTO、OpenAPI、移动端生成客户端与 `apps/admin/src/api/types.ts` 在同一实现步骤同步，不保留新旧字段并存的兼容响应。

### Admin 模型管理

供应商目录包含 OpenAI、Anthropic、DeepSeek、豆包、Kimi、Kimi Coding Plan、Google Gemini、通义千问、智谱 GLM、MiniMax，并继续保留 OpenRouter 和自定义 OpenAI 兼容服务。

供应商 Logo 固定放在 `apps/admin/public/model-providers/`，按 `providerKey` 映射，不作为上传资源。新增厂商使用官方提供且许可适合工程分发的 SVG 或 PNG，不从远端运行时加载。

推荐模型是快速添加模板：

- 不自动创建连接或模型。
- 不修改、重命名或覆盖现有 `ModelPreset`。
- 同连接下已有相同模型时显示“已添加”，禁用重复添加。
- 管理员仍可手填自定义模型，但未知模型不开放思考控件。

供应商分组摘要显示：

```txt
3 个连接 · 5 个模型
其中 1 个空连接
```

连接数统计 `ModelProviderConnection`，模型数统计其关联的现存模型预设并包含停用项，空连接数统计关联模型记录为零的连接。删除最后一个模型后连接仍保留，空连接数增加；停用模型不改变计数。

模型表单按服务端能力投影展示思考能力和生成参数限制，不允许管理员编辑能力。前端隐藏不支持的 `temperature/topP`，后端执行同样校验。

### Admin Agent 管理

执行方式使用“直接回答 / 自定义 Flow”分段选择：

- 直接回答：允许模型多选、默认模型单选，并显示默认模型对应的默认思考控件。
- 自定义 Flow：选择已发布 FlowVersion，隐藏并清空允许模型、默认模型和默认思考设置。

默认模型必须属于允许集合。更换默认模型时清除旧思考选择，并写入新模型的目录默认值。后端再次验证 direct 与 custom 两组配置互斥。

### Admin Flow 编辑器

每个真实 LLM 节点必须选择具体模型预设。节点检查器根据能力投影组合展示思考开关、effort 选择、token 预算或“自动”、固定思考只读状态；不支持思考时不显示控件。

更换模型时立即清除旧配置并采用新模型的目录默认值。保存与发布错误必须显示具体节点和不合法字段。

### Admin 调试聊天

调试聊天只运行 Agent 当前配置，不提供独立模型或思考选择：

- direct Agent 使用其默认模型和默认思考设置。
- 自定义 Flow Agent 使用各节点配置。

这样调试结果复现终端未覆盖时的默认行为，不形成第三套模型决策入口。

### 小程序

以下场景显示模型与思考入口：

- 单聊 direct Agent。
- 创建 direct Agent 新会话。
- 群聊中明确 `@` 某个 direct Agent。

以下场景隐藏入口：

- 绑定自定义 Flow 的 Agent。
- 群聊自动路由，回答 Agent 尚未确定。
- direct Agent 可用模型少于两个时隐藏模型切换器；若唯一模型支持可调思考，仍单独显示思考控件。

客户端从 Agent 模型选项接口读取允许集合、默认模型和能力投影。选择模型后，思考选择重置到该模型官方默认值。客户端按 Agent ID 记住最近选择，仅作为下次初值；发送文本或语音时始终提交本轮最终模型和嵌套 `reasoning`，服务端独立校验并固化。

模型或思考选择与上一轮不同时，界面提供不阻断的“建议新建会话”提示，不自动创建或切换会话。

## 错误规则

以下情况在任务落库和 Temporal 派发前返回明确参数错误：

- 自定义 Flow Agent 收到终端模型或 `reasoning`。
- direct Agent 没有允许模型或默认模型。
- 终端模型不属于 Agent 允许集合。
- 模型预设不存在、停用，或供应商连接未启用。
- 目录无法识别该模型，但请求携带 `reasoning`。
- 思考开关、effort、预算或其组合不受该模型支持。
- 关闭思考时仍携带 effort 或预算。
- Agent 默认思考设置与默认模型能力不匹配。
- 思考设置和模型生成参数组合违反目录约束。

以下情况在 Flow 保存或发布时返回带节点标识的错误：

- LLM 节点缺少具体模型或使用 `agent-default`。
- 节点引用的模型预设或连接不可用。
- 模型不满足节点已有的 basic/tools 能力要求。
- 节点思考选择缺失、包含多余字段或违反模型约束。
- 非 `model` 审批策略携带模型或思考设置。

运行时遇到目录与发布工件不一致时明确失败并记录安全元数据，不回退到 Agent 默认模型、系统默认模型或其他思考档位。

## 测试与验收

### 后端

- 表驱动测试覆盖推荐模型精确 ID、默认值、可组合控制项、请求映射、上下文策略和生成参数限制。
- 未知模型不返回思考能力，提交 `reasoning` 被拒绝。
- 推荐模型快速添加不覆盖同连接现有模型。
- 供应商摘要分别统计连接、模型和空连接；删除最后一个模型后连接保留且空连接数增加。
- direct Agent 的允许模型、默认模型和默认思考设置支持创建、更新及模式切换校验。
- 选择非默认模型且省略 `reasoning` 时使用该模型目录默认值，不误用 Agent 默认模型的配置。
- custom Agent 拒绝 direct 专属字段；自定义 Flow 拒绝缺省模型和 `agent-default`。
- 五类 LLM 节点分别校验模型与思考配置，更换模型不残留旧字段。
- 任务创建固化最终模型和思考设置；修改 Agent 默认值后，Temporal retry、重连和 HITL 恢复仍使用原快照。
- 对各 Provider 捕获实际请求体，断言厂商字段、关闭行为和生成参数限制均正确。
- Gemini 原生协议测试覆盖 thinking level、thinking budget、工具调用及 `thoughtSignature` 原样回传。
- HITL 中断前后的隐藏上下文可以从最终 checkpoint 重建。
- `modelContext` 按严格 schema 保存，只在目录判定兼容时回放。
- `modelContext` 不出现在会话 DTO、SSE、Trace、Flow 输出、Admin 响应或日志正文。
- 上下文提取失败不触发第二次模型或工具执行。

### Admin

- 供应商卡片清楚展示连接、模型和空连接三个数字。
- 删除模型后计数正确，连接不会被误判为残留模型。
- 九家供应商的推荐模型、能力摘要和 Logo 正确显示。
- 已存在模型不可重复添加，推荐模板不覆盖数据库记录。
- 模型、Agent 和五类 Flow LLM 节点按能力显示正确控件及默认值。
- direct/custom 切换清理互斥字段，模型切换清理旧思考选择。
- Admin 调试页没有模型或思考覆盖入口。

### 小程序

- 单聊、新建会话和明确 `@` direct Agent 时按规则显示入口。
- 自定义 Flow Agent 与群聊自动路由隐藏入口。
- 本机记忆按 Agent 隔离，发送请求携带当前最终选择。
- 模型切换重置为新模型目录默认思考设置。
- 模型或思考配置变化提示不阻断发送。
- 文本和语音使用同一套选择及校验语义。

### 构建检查

```bash
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check
pnpm --filter ./apps/admin run typecheck
pnpm --filter ./apps/admin run lint
pnpm --filter ./apps/admin run build
pnpm --filter ./apps/mobile run typecheck
pnpm --filter ./apps/mobile run build:weapp
pnpm build
```

## 迁移与部署

1. AI 只更新 `apps/api/prisma/schema.prisma`，由用户执行 `pnpm --filter ./apps/api run db:migrate`，迁移名使用 `add_model_reasoning_and_context`。
2. 更新后端能力目录、Provider 映射、DTO、Admin 手写类型和移动端 OpenAPI 生成物。
3. Flow Definition schema version 升到 `9`，现有 v8 Flow 重建草稿并重新发布。
4. 重启 API、Temporal Workflow Worker 和 Activity Worker，保证任务创建与执行使用同一版目录和快照契约。
5. 验收 direct Agent 终端切换、自定义 Flow 节点配置、九家厂商映射、隐藏上下文连续性以及 Temporal 重试一致性。

## 官方资料基线

- Anthropic：[模型目录](https://platform.claude.com/docs/en/models/overview)、[effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- Google Gemini：[JavaScript SDK](https://github.com/googleapis/js-genai)、[Thinking](https://ai.google.dev/gemini-api/docs/thinking)、[Thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures)
- DeepSeek：[模型与价格](https://api-docs.deepseek.com/quick_start/pricing)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- 豆包：[模型列表](https://www.volcengine.com/docs/82379/1330310)、[深度思考](https://www.volcengine.com/docs/82379/1449737)
- Kimi：[模型列表](https://platform.kimi.com/docs/models.md)、[reasoning_effort](https://platform.kimi.com/docs/guide/use-reasoning-effort.md)、[Thinking 模型](https://platform.kimi.com/docs/guide/use-thinking-models.md)、[Kimi Code 模型](https://www.kimi.com/code/docs/kimi-code/models.html)
- 通义千问：[模型目录](https://www.alibabacloud.com/help/en/model-studio/models)、[Deep thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)
- 智谱 GLM：[官方文档全集](https://docs.bigmodel.cn/llms-full.txt)
- MiniMax：[官方文档全集](https://platform.minimax.io/docs/llms-full.txt)
- OpenAI：官方页面本次无法访问；候选模型只使用 `openai-docs` 本地 fallback，不据此声明思考能力。

## 已接受代价

- 现有 v8 Flow 工件不兼容，需要重建草稿并重新发布。
- direct Agent 在迁移后若没有合法的允许模型或默认模型，或者可调思考的默认模型缺少合法默认选择，会明确拒绝聊天；固定思考和不支持思考的模型不要求保存 `reasoning`。
- 能力目录更新需要发布后端；管理员不能临时为未知模型声明未经核实的思考能力。
- Gemini 原生协议需要一个新的必要 Provider 依赖和上游格式。
- Message 会增加供应商私有隐藏上下文的存储量，但严格限制为后续调用所需内容，且不进入外部接口。
- 切换模型或思考设置只提示新建会话，不强制中断已有对话；不兼容的隐藏上下文不会回放。
