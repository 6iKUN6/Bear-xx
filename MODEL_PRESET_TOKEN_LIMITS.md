# 模型预设模板 Token 上限

> 核对日期：2026-09-17  
> 模型范围：`apps/api/src/modules/llm/model-provider-template.catalog.ts` 中的全部 32 个推荐模型。  
> 数值均为单次请求的模型级上限，不是账号 TPM/RPM 配额。

## 口径

- **最大上下文**：输入、历史消息、工具定义、思考内容与输出共同占用的总上下文窗口。
- **最大输出**：单次生成允许的最大 token 数，通常包含 reasoning / thinking token；并不保证在上下文已接近满载时仍可生成这么多。
- `1M` 在不同厂商文档中可能指 `1,000,000` 或 `1,048,576`。表中优先保留厂商给出的精确值。
- **证据 A**：厂商官方公开文档直接给出；**证据 B**：厂商只公开部分规格，缺项由 OpenRouter 模型目录交叉核对；**证据 C**：当前公开资料没有给出可确认的最大值。
- Admin 中的 `contextWindowTokens` / `maxOutputTokens` 是项目运行配置，不能自动代表供应商上限。生产配置还应预留系统提示词、工具 schema 与响应空间。

## 汇总

| 供应商模板 | 模型 ID | 最大上下文 | 最大输出 | 证据 | 备注 |
| --- | --- | ---: | ---: | :---: | --- |
| OpenAI | `gpt-5.6-sol` | 1,050,000 | 128,000 | B | OpenAI 官方模型页在本次核对环境返回 `Forbidden`；数值由 OpenRouter 目录交叉核对。 |
| OpenAI | `gpt-5.6-terra` | 1,050,000 | 128,000 | B | 同上。 |
| OpenAI | `gpt-5.6-luna` | 1,050,000 | 128,000 | B | 同上。 |
| Anthropic | `claude-fable-5-1` | 1,000,000 | 128,000 | B | Anthropic 官方索引确认模型存在，但正文因地区限制不可读取；数值由 OpenRouter 目录交叉核对。 |
| Anthropic | `claude-opus-5` | 1,000,000 | 128,000 | B | 同上。 |
| Anthropic | `claude-sonnet-5` | 1,000,000 | 128,000 | B | 同上。 |
| Anthropic | `claude-haiku-4-5` | 200,000 | 64,000 | B | 同上。 |
| DeepSeek | `deepseek-v4-pro` | 1,048,576（官方写作 1M） | 393,216（官方写作 384K） | A | DeepSeek 官方页直接给出 `1M / 384K`。 |
| DeepSeek | `deepseek-v4-flash` | 1,048,576（官方写作 1M） | 384,000 | A | 这是兼容别名；官方说明实际由 `deepseek-v4.1-flash` 提供服务。 |
| Kimi | `kimi-k3` | 1,048,576（官方写作 1M） | 1,048,576 | A | 官方说明 `max_completion_tokens` 默认 131,072，最大可设 1,048,576；实际输出仍受总上下文约束。 |
| Kimi | `kimi-k2.7-code` | 262,144（256K） | 未公开（默认 32,768） | C | 官方页只给出 256K 上下文及 `max_tokens` 默认 32K，没有声明参数最大值。 |
| Kimi | `kimi-k2.7-code-highspeed` | 262,144（256K） | 未公开（默认 32,768） | C | 与 `kimi-k2.7-code` 同模型，仅推理速度不同。 |
| Kimi | `kimi-k2.6` | 262,144（256K） | 未公开（默认 32,768） | C | 官方页没有声明 `max_tokens` 最大值。 |
| Kimi 编程套餐 | `k3` | 1,048,576（1M） | 1,048,576 | A | 编程套餐中的 K3 路由；输出仍受总上下文约束。 |
| Kimi 编程套餐 | `k3-256k` | 262,144（256K） | 未公开 | C | 套餐专用 256K 路由，公开文档没有给出最大输出。 |
| Kimi 编程套餐 | `kimi-for-coding` | 262,144（256K） | 未公开（默认 32,768） | C | 指向 Kimi K2.7 Code。 |
| Kimi 编程套餐 | `kimi-for-coding-highspeed` | 262,144（256K） | 未公开（默认 32,768） | C | 指向 Kimi K2.7 Code Highspeed。 |
| 豆包 | `doubao-seed-evolving` | 未公开 | 未公开 | C | 火山引擎公开页面未给出该模型的静态 token 上限。 |
| 豆包 | `doubao-seed-2-1-pro-260628` | 未公开 | 未公开 | C | 火山引擎公开页面未给出该快照的静态 token 上限。 |
| 豆包 | `doubao-seed-2-1-turbo-260628` | 未公开 | 未公开 | C | 火山引擎公开页面未给出该快照的静态 token 上限。 |
| Google Gemini | `gemini-3-pro-preview` | 1,048,576 | 65,536 | B | Google AI 文档在本次核对环境超时；数值由 OpenRouter 目录交叉核对。 |
| Google Gemini | `gemini-3-flash-preview` | 1,048,576 | 65,536 | B | 同上。 |
| Google Gemini | `gemini-2.5-pro` | 1,048,576 | 65,536 | B | 同上。 |
| Google Gemini | `gemini-2.5-flash` | 1,048,576 | 65,535 | B | OpenRouter 目录记录为 65,535；配置时可保守使用 65,535。 |
| 通义千问 | `qwen3.8-max` | 1,000,000 | 131,072 | A | 阿里云百炼官方页直接给出。 |
| 通义千问 | `qwen3.8-flash` | 1,000,000 | 131,072 | A | 阿里云百炼官方页直接给出。 |
| 通义千问 | `qwen3.7-plus` | 1,000,000 | 131,072 | A | 阿里云百炼官方页直接给出。 |
| 智谱 GLM | `glm-5.3` | 1,000,000 | 131,072（128K） | A | 智谱官方模型概览直接给出 `1M / 128K`。 |
| 智谱 GLM | `glm-5.3-flash` | 1,000,000 | 131,072（128K） | A | 智谱官方模型概览直接给出 `1M / 128K`。 |
| MiniMax | `MiniMax-M3` | 1,048,576（官方写作 1M） | 512,000 | B | MiniMax 官方页只明确 1M 上下文；最大输出由 OpenRouter 目录交叉核对。 |
| MiniMax | `MiniMax-M2.7` | 204,800（200K） | 131,072（128K） | B | MiniMax 当前官方总览未展示完整限制；数值由 OpenRouter 目录交叉核对。 |
| MiniMax | `MiniMax-M2.7-highspeed` | 204,800（200K） | 131,072（128K） | B | 与 `MiniMax-M2.7` 同模型，仅推理速度不同。 |

## 建议配置

1. 对证据 A 的模型，可直接以表中“最大上下文”填写 `contextWindowTokens`；`maxOutputTokens` 建议按业务所需设置较小值，不必顶格。
2. 对证据 B 的模型，上线前应在对应供应商控制台或实际 API 上再次确认；聚合目录可能滞后于供应商。
3. 对证据 C 的模型不要猜值。项目当前会在 `contextWindowTokens` 缺失时拒绝长对话预算，应先向供应商控制台确认后再启用。
4. 本项目校验要求 `maxOutputTokens < contextWindowTokens`。因此 Kimi K3 官方允许的极限输出值不能原样同时写入两栏；实际配置应把输出上限设为更小的业务值。

## 来源

- 模板清单：[Litter-Bear 模型供应商模板](apps/api/src/modules/llm/model-provider-template.catalog.ts)
- OpenAI 官方模型文档（本次访问返回 `Forbidden`）：<https://developers.openai.com/api/docs/models>
- Anthropic 官方文档索引：<https://docs.anthropic.com/llms.txt>
- DeepSeek 官方 Models & Pricing：<https://api-docs.deepseek.com/quick_start/pricing>
- Kimi K3 官方说明：<https://platform.kimi.com/docs/guide/kimi-k3-quickstart>
- Kimi K2.7 Code 官方说明：<https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart>
- Kimi K2.6 官方说明：<https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart>
- Google Gemini 模型文档（本次访问超时）：<https://ai.google.dev/gemini-api/docs/models>
- 阿里云百炼 Qwen 3.8 Max：<https://help.aliyun.com/zh/model-studio/qwen3-8-max>
- 阿里云百炼 Qwen 3.8 Flash：<https://help.aliyun.com/zh/model-studio/qwen3-8-flash>
- 阿里云百炼 Qwen 3.7 Plus：<https://help.aliyun.com/zh/model-studio/qwen3-7-plus>
- 智谱官方模型概览：<https://docs.bigmodel.cn/cn/guide/start/model-overview>
- MiniMax 官方模型总览：<https://platform.minimax.io/docs/guides/models-intro>
- OpenRouter 模型目录（二级交叉来源）：<https://openrouter.ai/api/v1/models>

## 维护说明

模型限制会随快照、区域、接口协议和供应商路由变化。修改 `MODEL_PROVIDER_TEMPLATES` 的推荐模型时，应同步更新本文，并重新核对供应商官方文档。
