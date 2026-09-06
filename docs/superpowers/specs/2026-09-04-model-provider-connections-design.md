# 模型供应商连接与预设模板设计

**日期：** 2026-09-04  
**状态：** 已实现，待数据库迁移与手工验收  
**范围：** 将模型配置拆分为供应商模板、供应商连接和模型预设；支持一份连接凭据复用给多个模型，并重构 Admin 模型管理界面。  
**不包含：** 供应商自动故障切换、远程同步模型目录、可编辑内置 Logo、自定义 Logo 上传、自定义请求头、网络代理、配置导入导出、旧模型预设兼容层。

## 背景与目标

当前 `ModelPreset` 同时保存供应商标签、`baseURL`、API Key、模型 ID 和生成参数。同一供应商下配置多个模型时，URL 与密钥会重复保存；修改密钥也必须逐条维护。模型注册表又是进程内缓存：Admin 写操作只刷新 API 进程，Temporal Activity Worker 仍可能持有启动时的旧配置，导致“后台测试连接成功，Flow 在请求模型前被运行时校验拒绝”。

本次改造的目标是：

- 像 CC Switch 一样先选择供应商模板，再创建一个或多个独立连接。
- 一份连接统一保存 URL 和 API Key，并供其下多个模型复用。
- Flow 继续引用稳定的具体模型预设，不因连接或显示名称变更而漂移。
- 内置供应商使用随代码发布的固定 Logo；管理员不能覆盖。
- 连接和模型分别探测，工具能力仍由具体模型的真实往返结果决定。
- API 与 Temporal Worker 对模型配置形成一致视图，避免跨进程旧缓存。

## 已确认决策

- 一个供应商连接可以挂多个模型预设。
- 同一供应商允许创建多份连接，例如“DeepSeek 官方”和“DeepSeek 备用中转”。
- 第一版不做自动故障切换；每个模型预设明确归属一个连接。
- 首批模板为 OpenAI、Anthropic、DeepSeek、Kimi、豆包、OpenRouter 和自定义 OpenAI 兼容服务。
- 模板提供推荐模型，同时允许管理员手动填写模型 ID；不调用供应商 `/models` 自动同步。
- 供应商 Logo 固定写入工程，内置 Logo 不可覆盖；自定义兼容服务使用统一通用图标。
- 模型 `presetId` 由服务端自动生成，创建后不可修改。
- 上游协议属于模型预设，不属于连接；同一连接下的模型可以使用模板允许的不同协议。
- 新增连接时必须同时创建至少一个模型。
- 连接探测与模型能力探测分离；Flow 工具校验只认可具体模型的 `tools` 档位。
- 删除连接和模型时检查下级资源与 Agent/Flow 引用，不级联破坏已发布工件。
- 连接 URL、密钥变化会重置其下全部模型；模型 ID、协议变化只重置该模型。
- 不保留旧数据结构兼容层，现有预设由管理员在迁移后重新配置。

## 领域模型

```txt
供应商模板（代码内置，后端为事实源）
  └── 供应商连接（数据库，URL + 凭据）
        └── 模型预设（数据库，模型 + 协议 + 生成参数 + 能力）
```

### 供应商模板

供应商模板不是数据库实体。后端维护闭集目录并通过 Admin API 下发：

```ts
interface ModelProviderTemplate {
  providerKey: string;
  name: string;
  defaultBaseURL: string | null;
  allowedUpstreamFormats: UpstreamFormat[];
  defaultUpstreamFormat: UpstreamFormat;
  recommendedModels: Array<{
    model: string;
    name: string;
    upstreamFormat: UpstreamFormat;
  }>;
}
```

首批默认值：

| `providerKey`   | 名称                   | 默认 `baseURL`                             | 默认协议                |
| --------------- | ---------------------- | ------------------------------------------ | ----------------------- |
| `openai`        | OpenAI                 | `https://api.openai.com/v1`                | OpenAI Responses        |
| `anthropic`     | Anthropic              | `https://api.anthropic.com`                | Anthropic Messages      |
| `deepseek`      | DeepSeek               | `https://api.deepseek.com/v1`              | OpenAI Chat Completions |
| `kimi`          | Kimi                   | `https://api.moonshot.cn/v1`               | OpenAI Chat Completions |
| `doubao`        | 豆包                   | `https://ark.cn-beijing.volces.com/api/v3` | OpenAI Chat Completions |
| `openrouter`    | OpenRouter             | `https://openrouter.ai/api/v1`             | OpenAI Chat Completions |
| `custom-openai` | 自定义 OpenAI 兼容服务 | 无                                         | OpenAI Chat Completions |

OpenAI 模板允许 `openai_responses` 和 `openai_chat_completions`；Anthropic 固定为 `anthropic_messages`；其余首批模板按当前运行时能力固定为 `openai_chat_completions`。后端在创建和更新模型时按模板校验协议，不能依赖前端选项隐藏代替校验。

推荐模型目录只降低填写成本，不构成供应商完整模型清单。管理员可以输入模板允许协议下的新模型 ID，因此供应商发布新模型时不需要先升级系统。

### 供应商连接

Prisma 新增 `ModelProviderConnection`：

```txt
id                   String
connectionKey        String  @unique
providerKey          String
name                 String
baseURL              String
enabled              Boolean
apiKeyCiphertext     String?
apiKeyFingerprint    String?
status               ModelProviderConnectionStatus
lastCheckedAt        DateTime?
lastCheckError       String?
createdAt            DateTime
updatedAt            DateTime
models               ModelPreset[]
```

连接状态闭集：

```txt
UNVERIFIED
REACHABLE
UNREACHABLE
```

`connectionKey` 由服务端根据 `providerKey` 和短随机段生成，例如 `deepseek-k7m4p2`。它不随连接显示名变化，主要用于生成稳定的模型业务 ID，不作为页面主标题。

`providerKey` 与 `connectionKey` 创建后均不可修改。需要从另一供应商或另一类模板接入时应新建连接，避免已有 Logo、协议约束和模型语义被原地改写。

新建连接必须提供非空 API Key；编辑连接时不传 API Key 表示保持现有密钥不变，不提供把密钥清空成不可运行配置的隐式操作。密钥继续复用现有 AES-256-GCM 加密和不可逆指纹逻辑。明文只存在于写入和实际请求期间，任何列表、详情、错误和日志均不得返回或记录明文。

### 模型预设

现有 `ModelPreset` 调整为：

```txt
id                   String
connectionId         String
presetId             String  @unique
name                 String
description          String
model                String
upstreamFormat       ModelUpstreamFormat
temperature          Float?
maxOutputTokens      Int?
topP                 Float?
enabled              Boolean
isDefault            Boolean
capability           ModelPresetCapability
lastCheckedAt        DateTime?
lastCheckError       String?
createdAt            DateTime
updatedAt            DateTime
connection           ModelProviderConnection
```

从 `ModelPreset` 删除 `platform`、`baseURL`、`apiKeyCiphertext` 和 `apiKeyFingerprint`。运行时通过 `connection` 读取供应商、URL 和密钥。

`presetId` 在创建时生成：

```txt
<connectionKey>:<创建时的模型 ID>
```

模型 ID 中的 `/`、`.`、`-` 等供应商合法字符原样保留；整个 `presetId` 做长度与唯一性校验。创建后即使修改模型 ID，`presetId` 也不变化，保证 Agent 和 Flow 的持久化引用稳定。页面默认展示模型名称和连接名称，只在详情中显示只读 `presetId`。

## URL 与协议语义

连接的 `baseURL` 永远表示 API 根地址，具体资源路径由选定的 LangChain/上游 SDK 追加：

```txt
https://api.deepseek.com/v1
  + /chat/completions
  = https://api.deepseek.com/v1/chat/completions
```

服务端统一去除末尾 `/`，并要求 URL 使用 `http` 或 `https`。若路径以以下完整端点结尾则拒绝保存，并返回应填写 API 根地址的明确错误：

```txt
/chat/completions
/responses
/messages
```

Admin 表单根据当前协议展示“实际请求端点”预览。该预览只用于解释拼接结果，运行时仍由 SDK 构造请求，不在业务层手工拼接文本生成端点。

## 管理端信息架构

采用供应商优先的页面结构：

```txt
模型供应商卡片
  → 供应商详情
      → 连接列表
          → 连接配置与模型列表
```

### 供应商首页

每张供应商卡片展示：

- 固定品牌 Logo 和供应商名称。
- 已启用连接数、模型总数和不可用模型数。
- 最近一次连接状态摘要。
- “添加连接”和“查看详情”操作。

未配置连接的内置供应商仍展示，作为创建入口。自定义 OpenAI 兼容服务只显示一张固定通用卡片，其下可以创建多份自定义连接。

### Logo 资产

品牌 Logo 放在：

```txt
apps/admin/public/model-providers/
```

页面通过固定 `providerKey` 映射本地静态 SVG。优先采用供应商官方公开品牌资源；官方未提供适合后台小尺寸展示的版本时，采用可追溯来源的品牌图标，并随资源记录来源和许可。不得热链供应商网站或第三方 CDN，也不新增整套图标依赖。

内置供应商和自定义兼容服务均没有 Logo 编辑字段。未知 `providerKey` 不冒充某个已知品牌，回退到通用连接图标和供应商原始名称。

### 新建连接

新建流程为一个分步 Sheet：

1. 从供应商卡片进入，模板已经确定。
2. 填写连接名称、`baseURL` 和 API Key。
3. 从推荐模型勾选一个或多个模型，或手动添加模型 ID。
4. 为每个模型确认显示名称和协议。
5. 保存连接与初始模型。
6. UI 随后调用连接探测；探测失败不回滚已保存配置，而是保留连接并展示可修复的失败原因。

主操作文案为“保存并测试”。两次请求的状态必须诚实展示：如果保存成功而探测失败，提示“连接已保存，但测试未通过”，不能显示整体失败后诱导用户重复创建。

### 连接详情

连接详情展示：

- 连接名称、供应商、URL、启用状态和密钥脱敏标识。
- 连接状态、最后探测时间和安全错误摘要。
- 其下模型列表及各自的协议、能力档位、启用和默认状态。
- 编辑连接、更新密钥、测试连接、添加模型和删除连接。

修改 URL、API Key 或禁用连接前，页面展示受影响模型数、Agent 引用数和 Flow 引用数并二次确认。后端仍独立执行状态重置和引用护栏，不能依赖前端确认保证正确性。

### 模型管理

模型列表支持：

- 从模板推荐列表添加或手工添加。
- 编辑显示名称、描述、模型 ID、协议与生成参数。
- 独立执行完整能力探测。
- 查看 Agent、草稿 Flow 和已发布 Flow 的引用明细。
- 启用、禁用和删除。

Flow 节点检查器继续选择具体 `presetId`。选项同时展示“模型名称 / 连接名称 / 供应商 Logo”，但 Definition 只保存 `presetId`，不保存连接 ID 或显示文本。

## Admin API

管理后台继续只消费 `/admin/*`。新增连接和模板端点，保留模型预设作为独立资源：

```txt
GET    /admin/model-provider-templates

GET    /admin/model-provider-connections
POST   /admin/model-provider-connections
GET    /admin/model-provider-connections/:id
PATCH  /admin/model-provider-connections/:id
DELETE /admin/model-provider-connections/:id
POST   /admin/model-provider-connections/:id/probe

POST   /admin/model-provider-connections/:connectionId/models
GET    /admin/model-presets/:id
PATCH  /admin/model-presets/:id
DELETE /admin/model-presets/:id
POST   /admin/model-presets/:id/probe
GET    /admin/model-presets/:id/references
```

创建连接请求包含至少一个初始模型，服务端在单一事务中创建连接和模型。任何初始模型无效时整体不落库。连接探测从已保存的子模型中选择一个 `modelPresetId`，只做最小对话请求并更新连接状态。

列表和详情 DTO 直接返回页面需要的计数与安全投影，避免前端按连接逐条发送请求。`apps/admin/src/api/types.ts` 必须与后端 DTO 同步更新；本项目没有契约生成工具替双方发现漂移。

模型引用查询使用 `validateFlowDefinition` 解析 Flow JSON 后遍历 `agent`、`plan-loop.executor` 和 `synthesize` 节点，不用 JSON 文本模糊搜索。返回 Agent 名称、Flow 名称、版本号和版本状态，供阻止删除与确认影响范围复用同一判据。

以上端点继续仅允许 `SUPER_ADMIN`，与当前模型密钥管理权限一致。

## 探测语义

### 连接探测

连接探测验证：

- 连接已启用且配置了密钥。
- 选中的模型属于该连接且已启用。
- `baseURL + API Key + 模型 ID + 协议` 能完成最小对话请求。

成功写入 `REACHABLE`；失败写入 `UNREACHABLE` 和安全错误摘要。连接探测不声称模型支持工具，也不修改模型的 `capability`。

### 模型能力探测

模型探测沿用现有两级语义：

1. L1：完成一次最小对话。
2. L2：模型发起指定测试工具调用，服务端回填工具结果，模型完成最终回复。

结果继续映射为：

```txt
unreachable  L1 失败
basic        L1 成功，L2 失败
tools        L1 与 L2 均成功
```

模型探测使用所属连接的已落库密钥和 URL。连接被禁用或缺少密钥时明确拒绝，不把配置缺失写成供应商网络故障。

## 状态失效规则

连接以下字段变化时：

```txt
baseURL
apiKey
```

在同一数据库事务中执行：

- 连接状态重置为 `UNVERIFIED`。
- 连接探测时间和错误清空。
- 其下全部模型能力重置为 `UNVERIFIED`。
- 全部模型探测时间和错误清空。

连接显示名称变化不影响探测状态。连接禁用不会伪造探测失败，但运行时立即排除该连接下的全部模型；重新启用后要求重新探测，因此启用操作同样将连接和模型重置为未探测。

模型的 `model` 或 `upstreamFormat` 变化时，只重置该模型。显示名称、描述和生成参数变化不重置连接或工具能力结论。

## 删除与引用护栏

- 连接下还有模型时禁止删除，并返回模型数量。
- 模型被任何 Agent 默认模型引用时禁止删除。
- 模型被 DRAFT 或 PUBLISHED FlowVersion 引用时禁止删除。
- ARCHIVED FlowVersion 和历史 StreamTask 继续保留不可变快照与审计事实，不级联删除；历史工件不作为第一版重新启用入口。
- 删除操作先复用引用查询返回明确位置，再执行数据库删除；不能依赖外键错误作为用户文案。
- 被引用模型允许禁用，作为紧急止损手段，但 Admin 必须二次确认影响范围。
- 连接禁用后，其下模型不进入运行时可用模型集合，新任务在创建期被明确拒绝。

本次不把 Flow JSON 引用改成数据库外键。Flow Definition 继续以 `presetId` 表达跨版本稳定引用，发布和任务创建期由运行时校验器做闭集校验。

## 运行时解析与跨进程一致性

`LlmModelRegistryService` 查询模型时联表读取启用的连接，并将连接字段投影进现有 `ResolvedLlmTextRequest`：

```txt
provider       继续由 upstreamFormat 推导
platform       来自 connection.providerKey
baseURL        来自 connection.baseURL
apiKey         由 connection.apiKeyCiphertext 临时解密
model          来自 ModelPreset.model
generation     来自 ModelPreset 生成参数
```

只有连接和模型都启用的预设才进入可用集合。带工具节点继续要求具体预设能力为 `tools`。

为消除 API 与 Temporal Worker 的进程内缓存分歧：

- Admin 写操作后刷新 API 当前进程注册表。
- Temporal Activity Worker 在每次 `executeNode`、`continueNode` 和 `resumeNode` 共用的 `loadExecutionContext` 编译前刷新注册表。
- 刷新完成后再做 `model-preset-exists` 和 `model-preset-tool-capability` 校验，并在本次 Activity 内解析同一份注册表数据。
- 编译失败的 ApplicationFailure 保留安全的 `path / rule / message` 摘要，不再只留下“Flow 任务期能力校验失败”。

当前规模下每个 Activity 边界读取一次启用模型与连接的成本有限，优先换取确定性。第一版不增加 Redis 发布订阅、轮询器或分布式缓存失效协议。

模型连接配置不是 FlowVersion Definition 的一部分。管理员在运行期间修改连接会从下一次 Activity 起生效；已完成节点仍由 `AgentFlowNodeExecution` 幂等事实回放，不会因配置变更重复执行工具。若变更使后续节点不可运行，任务明确失败并记录具体运行时校验原因，不静默切换连接。

## 错误处理

- URL/端点不合法：保存前返回字段级错误。
- 新建连接密钥缺失：保存前返回字段级错误；编辑时留空只表示不修改已保存密钥。
- 保存成功、自动探测失败：保留连接，展示“已保存但不可达”和上游安全摘要。
- 模型只通过基础对话：显示 `basic` 警告，可用于无工具节点，不可用于带工具节点。
- 连接或模型被禁用：新任务在创建期返回引用的连接/模型不可用，不伪装成空模型列表。
- 删除存在引用：返回引用明细和可操作建议，不级联删除。
- Worker 编译上下文失败：日志和任务错误保留规则、路径与安全消息，不包含密钥、请求体或供应商原始响应。

## 数据迁移与重新配置

本次不写兼容层，也不自动解密并搬运旧凭据。生成迁移前，现有数据必须满足：

1. 记录当前供应商、URL、模型和生成参数；API Key 无法从 Admin 回显，需要准备原始密钥。
2. 将 Agent 的默认模型引用清空或准备迁移后重新绑定。
3. 将现有模型预设取消默认并删除，确保 `model_presets` 表为空。
4. 记录显式引用旧 `presetId` 的草稿和已发布 Flow；迁移后修改并重新发布。

实现只修改 `apps/api/prisma/schema.prisma`，不手写或编辑 `migration.sql`。建议迁移名：

```txt
split_model_provider_connections
```

由用户本地执行：

```bash
pnpm --filter ./apps/api run db:migrate
```

迁移后按顺序执行：

1. 创建供应商连接并重新填写 API Key。
2. 创建并探测模型预设。
3. 重新绑定 Agent 默认模型。
4. 更新显式引用旧 `presetId` 的 Flow 草稿，校验并重新发布。
5. 重启或重新构建容器后执行真实 Flow 回归。

## 实施拆分

### 第一步：数据与后端

- 新增连接模型、状态枚举和 `ModelPreset` 关系。
- 增加模板目录与连接 CRUD。
- 重构模型 CRUD、探测和注册表解析。
- 增加 URL 校验、状态失效和引用查询。
- 修复 Activity Worker 注册表刷新与运行时错误摘要。

### 第二步：Admin

- 增加供应商卡片页和连接详情。
- 实现连接创建 Sheet、模型添加和两级探测反馈。
- 接入本地品牌 Logo 和固定映射。
- 更新 Flow 模型选择器展示信息。
- 同步手写 DTO 类型、API 端点和 TanStack Query 缓存失效。

### 第三步：护栏与回归

- 完成连接批量失效、删除引用保护和禁用确认。
- 覆盖测试连接成功但 Flow Worker 使用旧注册表的回归用例。
- 回归 Agent 默认模型、显式 Flow 模型、无工具节点和带工具节点。

## 验证

后端定向测试至少覆盖：

- 模板协议闭集与 `baseURL` 端点校验。
- 创建连接和多个初始模型的事务一致性。
- 同供应商多连接及自动生成 ID 的唯一性。
- 连接字段变化重置全部子模型，模型字段变化只重置自身。
- 连接与模型双重启用过滤。
- 连接密钥只解密到实际请求对象，不出现在 DTO 和日志。
- 连接探测不误标工具能力，模型探测正确写回 `basic/tools`。
- Agent、DRAFT/PUBLISHED Flow 引用阻止模型删除。
- Activity Worker 刷新后能看到 API 进程刚更新的预设。
- Temporal 重试已完成节点时仍回放执行事实，不重复调用工具。

完成后执行：

```bash
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check

cd apps/api
npx jest src/modules/admin/model-provider src/modules/admin/model-preset src/modules/llm src/modules/agent-flow/runtime --runInBand --no-watchman
npx jest src/temporal/workflows/agent-flow.workflow --runInBand --no-watchman

pnpm --filter ./apps/admin run typecheck
pnpm --filter ./apps/admin run lint
pnpm --filter ./apps/admin run build
pnpm build
```

Temporal 集成套件以 Jest 汇总的通过数判断；测试结束后 Temporal 测试环境可能持续输出 `Connection refused` 并挂住，不能只依据进程退出码判断结果。

## 验收标准

- 创建一份 DeepSeek 连接时只填写一次 URL 和 API Key，可以在其下创建 `deepseek-chat` 与 `deepseek-reasoner`。
- 同一供应商可创建第二份独立连接，两份连接的模型和凭据互不覆盖。
- 供应商首页使用固定本地 Logo，后台不存在 Logo 上传或覆盖入口。
- `baseURL` 填 `https://api.deepseek.com/v1` 时实际请求 `/chat/completions`；误填完整端点会得到明确校验错误。
- 修改连接密钥后，其下所有模型变为未探测；重新探测前带工具 Flow 被拒绝。
- 单独修改一个模型 ID 不影响同连接其他模型的能力档位。
- Admin 测试成功后，Temporal Activity Worker 无需重启即可在下一节点看到最新连接配置。
- 一个模型被 Agent 或有效 FlowVersion 引用时不能删除，并能看到引用位置。
- 禁用连接后新任务被明确拒绝，不会自动切到同供应商的另一条连接。
- Temporal 重试同一已完成节点不会重复调用模型或已审批工具。
