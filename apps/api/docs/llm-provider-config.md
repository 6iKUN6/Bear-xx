# LLM 模型供应商配置规范

本文档用于说明当前后端 `llm` 模块如何接入不同模型供应商，以及推荐的配置方式。

## 当前设计

当前 `llm` 模块采用三层轻量结构：

- `LlmService`：负责消息转换、流式输出编排、对外暴露统一调用入口
- `LlmModelRegistryService`：负责解析 `modelId / provider / platform / model`，合并模型预设和默认参数
- `OpenAiCompatibleLlmProvider`：负责创建 OpenAI 兼容协议的 LangChain 聊天模型实例

当前仅内置一个 provider 实现：

- `openai`

这里的 `openai` 表示“OpenAI 兼容协议 provider”，不是只能调用 OpenAI 官方。

因此豆包、DeepSeek、Kimi 这类兼容 OpenAI 接口的供应商，当前都应按以下方式接入：

- `provider` 固定为 `openai`
- `platform` 填具体商家名，例如 `deepseek`、`kimi`、`doubao`
- `model` 填供应商要求的真实模型名
- `baseURL` 填供应商网关地址
- `apiKey` 填供应商密钥

对于供应商侧的代码组织，推荐放在 `src/modules/llm/providers/<platform>.ts` 中，并遵循以下约束：

- 每个文件只描述一个供应商
- 文件内部优先声明该供应商常用模型枚举
- 文件对外暴露 `createXxxModelPreset(...)`
- 该函数只负责创建模型预设实体，不直接负责调用 LangChain
- 真正的模型实例化统一交给 `OpenAiCompatibleLlmProvider`

例如：

- `providers/doubao.ts`
- `providers/deepseek.ts`
- `providers/kimi.ts`

这样可以保证“供应商差异”停留在配置层，而不是散落到业务调用链路里。

## 推荐配置原则

- 对话链路优先通过 `modelId` 选择模型，不建议在业务层硬编码 `baseURL`
- 模型预设放到 `LLM_MODEL_PRESETS`，让会话创建、任务恢复、重连续流都使用同一份解析结果
- 默认模型通过 `LLM_DEFAULT_MODEL_ID` 指定，而不是散落在业务代码里
- `provider` 只表示 SDK/协议实现，不直接表示商家品牌
- `platform` 才表示实际商家或模型平台

## 环境变量说明

- `LLM_MODEL`
  当请求未传模型选择信息，且未配置 `LLM_DEFAULT_MODEL_ID` 时使用的通用默认模型名。
- `LLM_DEFAULT_MODEL_ID`
  默认模型预设 ID，优先级高于 `LLM_MODEL`。
- `LLM_MODEL_PRESETS`
  JSON 数组格式的模型预设列表。
- `OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL`
  OpenAI 官方模型的默认鉴权、网关和模型名，其中 `OPENAI_API_KEY` 同时也用于语音转写和图片生成。
- `DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL`
  DeepSeek 模型预设的默认鉴权、网关和模型名。
- `KIMI_API_KEY / KIMI_BASE_URL / KIMI_MODEL`
  Kimi 模型预设的默认鉴权、网关和模型名。
- `DOUBAO_API_KEY / DOUBAO_BASE_URL / DOUBAO_MODEL`
  豆包模型预设的默认鉴权、网关和模型名。

## 模型预设格式

`LLM_MODEL_PRESETS` 中的每个对象支持以下字段：

```json
{
  "id": "deepseek:deepseek-chat",
  "provider": "openai",
  "platform": "deepseek",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxx",
  "enabled": true,
  "temperature": 0.7,
  "maxOutputTokens": 4096,
  "topP": 1
}
```

字段语义：

- `id`：模型预设唯一标识，建议使用 `平台:模型名`
- `provider`：调用实现名，当前固定为 `openai`
- `platform`：实际供应商或平台名
- `model`：真实模型名
- `baseURL`：供应商 API 地址
- `apiKey`：供应商 API Key
- `enabled`：是否启用
- `temperature / maxOutputTokens / topP`：该模型的默认生成参数

## 配置示例

### 1. OpenAI 官方

```env
OPENAI_API_KEY=sk-openai-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
LLM_DEFAULT_MODEL_ID=openai:gpt-4o-mini
LLM_MODEL_PRESETS=[{"id":"openai:gpt-4o-mini","provider":"openai","platform":"openai","model":"gpt-4o-mini","baseURL":"https://api.openai.com/v1","apiKey":"sk-openai-xxx"}]
```

### 2. DeepSeek

```env
LLM_DEFAULT_MODEL_ID=deepseek:deepseek-chat
LLM_MODEL_PRESETS=[{"id":"deepseek:deepseek-chat","provider":"openai","platform":"deepseek","model":"deepseek-chat","baseURL":"https://api.deepseek.com/v1","apiKey":"sk-deepseek-xxx"}]
```

### 3. Kimi

```env
LLM_DEFAULT_MODEL_ID=kimi:kimi-k2
LLM_MODEL_PRESETS=[{"id":"kimi:kimi-k2","provider":"openai","platform":"kimi","model":"kimi-k2-0711-preview","baseURL":"https://api.moonshot.cn/v1","apiKey":"sk-kimi-xxx"}]
```

### 4. 豆包

```env
LLM_DEFAULT_MODEL_ID=doubao:doubao-seed-1-6
LLM_MODEL_PRESETS=[{"id":"doubao:doubao-seed-1-6","provider":"openai","platform":"doubao","model":"doubao-seed-1-6-250615","baseURL":"https://ark.cn-beijing.volces.com/api/v3","apiKey":"sk-doubao-xxx"}]
```

### 5. 同时注册多个供应商

```env
LLM_DEFAULT_MODEL_ID=deepseek:deepseek-chat
LLM_MODEL_PRESETS=[{"id":"openai:gpt-4o-mini","provider":"openai","platform":"openai","model":"gpt-4o-mini","baseURL":"https://api.openai.com/v1","apiKey":"sk-openai-xxx"},{"id":"deepseek:deepseek-chat","provider":"openai","platform":"deepseek","model":"deepseek-chat","baseURL":"https://api.deepseek.com/v1","apiKey":"sk-deepseek-xxx"},{"id":"kimi:kimi-k2","provider":"openai","platform":"kimi","model":"kimi-k2-0711-preview","baseURL":"https://api.moonshot.cn/v1","apiKey":"sk-kimi-xxx"},{"id":"doubao:doubao-seed-1-6","provider":"openai","platform":"doubao","model":"doubao-seed-1-6-250615","baseURL":"https://ark.cn-beijing.volces.com/api/v3","apiKey":"sk-doubao-xxx"}]
```

## 接口传参建议

推荐优先传：

```json
{
  "modelId": "deepseek:deepseek-chat"
}
```

不推荐在业务请求里长期传整套供应商细节。原因是：

- 不利于任务恢复时复用同一份模型配置
- 容易让 controller/service 直接耦合供应商细节
- 后续切换默认参数时要改多个调用方

如果确实需要临时指定，也可以传：

```json
{
  "provider": "openai",
  "platform": "deepseek",
  "model": "deepseek-chat"
}
```

## 后续扩展方式

如果后续要接入“非 OpenAI 兼容协议”的供应商，按下面步骤扩展：

1. 在 `llm.types.ts` 中补充新的 `LlmProviderName`
2. 在 `LlmService` 中补充对应 provider 的分发逻辑
3. 新增一个 provider 实现，负责创建对应 LangChain 模型
4. 在 `llm.module.ts` 注册该 provider
5. 保持业务层仍只调用 `LlmService`

这样可以扩展供应商实现，但不会把聊天链路重新变回多层深调用。
