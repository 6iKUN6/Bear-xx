# LLM 模型供应商配置

聊天模型的唯一配置来源是数据库：管理员在后台创建**供应商连接**（地址 + 加密密钥），再在连接下添加**模型预设**。环境变量不再提供任何模型地址、密钥或默认模型。

设计取舍与演进过程见 `docs/superpowers/specs/2026-09-04-model-provider-connections-design.md`、`2026-09-04-agent-flow-model-ownership-design.md`、`2026-09-05-model-reasoning-configuration-design.md`；本文只描述现状与操作方式。

## 数据模型

```txt
ModelProviderConnection   一个供应商账号：providerKey / baseURL / apiKey 密文 / 连通状态
  └─ ModelPreset          连接下的一个模型：model / upstreamFormat / token 预算 / 能力档位
       ├─ Agent.defaultModelPreset     智能体默认模型
       └─ AgentAllowedModelPreset      智能体允许终端选择的模型集合（默认模型必须在其中）
```

- `presetId` = `${connectionKey}:${model}`，创建后不可变；Agent、任务快照与 Flow Definition 都按它引用模型。
- apiKey 用 `LLM_CREDENTIAL_ENCRYPTION_KEY` 做 AES-GCM 加密后存入 `api_key_ciphertext`，只在发起模型调用时解密，明文不写回缓存、不下发前端（前端只拿指纹尾号）。这把密钥丢失或更换后，已存密文全部无法解密，需要在后台逐个重填。
- `upstreamFormat` 是唯一决定 SDK 的字段：`openai_chat_completions` / `openai_responses` / `anthropic_messages` / `gemini_generate_content`；provider 由它推导（`llm-upstream-format.ts`），不单独存储。

## 供应商模板

`src/modules/llm/model-provider-template.catalog.ts` 是 providerKey、默认地址、允许的 wire 格式和推荐模型的唯一事实源，后台通过 `GET /admin/model-provider-templates` 只读消费。当前内置：OpenAI、Anthropic、DeepSeek、Kimi、Kimi 编程套餐、豆包、Google Gemini、通义千问、智谱 GLM、MiniMax、OpenRouter，以及自定义 OpenAI 兼容端点（`custom-openai`）。

推荐模型带 `contextWindowTokens` / `maxOutputTokens` 默认值：新建预设时请求未携带的字段按模板补齐，显式传入的值（包括 `null`）原样保留。数值来源与核对口径见仓库根目录 `MODEL_PRESET_TOKEN_LIMITS.md`；对已有预设可运行 `pnpm --filter ./apps/api exec node scripts/backfill-model-token-limits.cjs` 补齐空值。

## 后台操作流程

1. **新建供应商连接**（`POST /admin/model-provider-connections`）：选模板、填 apiKey，可同时勾选推荐模型一并创建。服务端校验 baseURL 与 wire 格式是否属于该模板。
2. **探测连接**（`POST /admin/model-provider-connections/:id/probe`）：最小请求验证地址与密钥。
3. **添加/编辑模型**（`POST /admin/model-provider-connections/:id/models`、`PATCH /admin/model-presets/:id`）：可从模板一键填写。
4. **探测模型能力**（`POST /admin/model-presets/:id/probe`）：实测写回能力档位——`UNVERIFIED` 未探测、`UNREACHABLE` 不可达、`BASIC` 仅能对话、`TOOLS` 工具往返通过。**带工具的 Flow 节点只接受 `TOOLS` 档位**，档位来自真实探测而不是配置声明。
5. **配置智能体**：设置允许模型集合与默认模型。删除或停用被引用的预设前，用 `GET /admin/model-presets/:id/references` 查看影响面。

## 运行时约束

- `LlmModelRegistryService` 启动时加载「启用的预设 + 启用的连接」，后台写操作后重新加载。数据库不可用时直接报错，不降级到任何静态配置。
- Flow 的模型节点必须能解析出 `contextWindowTokens`；未配置时任务创建即失败（「请在后台为模型配置上下文容量」）。`maxOutputTokens` 未配置时按上下文的 1/4 预留输出，必须小于上下文容量。
- 模型节点写具体 `presetId`；只有内置 direct Flow 可使用 `agent-default`，在任务创建时解析为「本轮选择 ?? 智能体默认模型」，且必须在允许集合内。
- 思考（reasoning）与识图能力由 `model-reasoning.catalog.ts` / `model-vision.catalog.ts` 按 (platform, wire 格式, model) 匹配，终端控件完全由目录驱动，不按模型名猜测。
- 业务层只调用 `LlmService`；具体 SDK 实例由 `LlmChatModelFactory` 按 `upstreamFormat` 创建。

## 扩展方式

- **新增 OpenAI / Anthropic 兼容的供应商**：在模板目录加一项（providerKey、默认地址、允许格式、推荐模型及 token 上限），后台在 `model-provider-logo.tsx` 补 Logo；模型有思考或识图能力时同步补两个能力目录。不需要改调用链路。
- **新增 wire 格式**：同时修改 Prisma 枚举 `ModelUpstreamFormat`（经迁移）、`llm-upstream-format.ts` 的映射，以及 `LlmChatModelFactory` 的构造分支。

## 与模型无关的环境变量

以下能力不走模型预设，仍由环境变量配置，见 `.env.example`：

- `OPENAI_API_KEY` + `AI_WHISPER_MODEL` / `AI_IMAGE_MODEL`：语音转写与 `/chat` 图片生成（`AiService`，直连 OpenAI）。
- `IMAGE_GEN_*`：生图工具与 `/images` 接口的生图 provider。
- `TAVILY_API_KEY`：联网搜索工具。
- `LLM_MAX_RETRIES` / `LLM_TIMEOUT_MS` / `LLM_DEBUG*`：全局调用健壮性与调试日志。
