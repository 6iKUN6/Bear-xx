# 聊天识图设计

## 目标

在微信小程序聊天中支持单张图片输入，并让 Kimi K3、Kimi Coding Plan K3 与 GPT-5.6 系列通过现有 AgentFlow 生成回答。图片可单独发送，也可附带文字。

## 产品边界

- 每条用户消息最多一张图片。
- 支持拍照与相册选择。
- 支持 JPEG、PNG、WebP；客户端负责把其它可解码格式转换为 JPEG。
- 图片长边超过 2048px 或文件超过 2 MiB 时，客户端在上传前压缩。
- 压缩后文件不得超过 4 MiB。
- 纯图片消息在模型侧补充“请描述并分析这张图片”，聊天气泡不展示该补充文字。
- 第一版只支持小程序聊天入口，不扩展 Admin 调试聊天。

## 数据模型与契约

`Message` 新增可空的 `imageAssetId` 外键，指向 `StorageAsset`。现有 `imageUrl` 继续表示 AI 生图结果，避免混淆用户附件与模型产物。

聊天 DTO 新增可空 `imageAssetId`。后端只接收资产 ID，不接受任意 URL 或 Base64。任务载荷和 Temporal 载荷只保存资产 ID，不保存图片二进制、签名 URL或 Base64。

会话历史返回 `imageUrl`，由资产 key 与当前 COS/CDN 域名动态生成。这样更换访问域名时无需迁移历史消息。

## 资产校验

创建任务前验证资产：

- 归属当前用户；
- `kind=IMAGE`、`usage=chat-image`、`status=ACTIVE`；
- MIME 为 JPEG、PNG 或 WebP；
- 登记大小不超过 4 MiB；
- 消息文字和图片至少存在一个。

图片资产校验失败时不创建用户消息、助手占位消息或 StreamTask。

## Flow 与模型能力

新增服务端视觉能力目录，以 `providerKey + upstreamFormat + model` 为键。第一版允许：

- Kimi `kimi-k3`；
- Kimi Coding Plan `k3`、`k3-256k`；
- OpenAI `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`。

图片只注入当前任务可能成为最终回答者的 `agent` 或 `synthesize` 节点。规划、审批、条件和中间 Agent 默认只消费文字。任务创建前检查所有可能的回答节点；任一节点模型不支持视觉时明确拒绝，不自动换模型、不静默丢图。

## 供应商传输

- GPT-5.6 Responses 直接使用可公开访问的 COS/CDN URL。
- Moonshot K3 优先使用供应商文件引用；文件引用未实现或失效时，由 Activity Worker 下载一次并发送 Base64。
- Kimi Coding Plan K3 第一版使用 Activity Worker 下载一次并发送 Base64。
- 同一节点的工具循环复用已构造的 LangChain 图片消息，不重复下载。

供应商文件缓存可后续独立实现。第一版不提前增加未经实测的 Kimi Coding Plan Files API 集成。

## 小程序数据流

```text
选图/拍照
-> 必要时本地压缩与转码
-> 校验不超过 4 MiB
-> COS 预签名直传
-> 登记 chat-image 资产
-> 聊天请求提交 imageAssetId
-> 本地用户气泡展示图片
-> AgentFlow 回答节点读取并注入图片
```

上传失败保留输入草稿和图片预览；聊天任务失败保留错误消息。图片发送成功后清空本地临时图片状态。

## 验证

- DTO：纯文本、图文、纯图片合法；空消息、越权资产、错误 MIME、超限资产被拒绝。
- Flow：视觉模型可创建任务；任一可能回答节点不支持视觉时被拒绝。
- 模型映射：OpenAI Responses 使用 URL；K3 使用正确的 Data URI 内容块。
- 幂等：Temporal Activity 重试不重复创建消息或执行工具。
- 小程序：选图、拍照、压缩、删除预览、纯图发送、历史回显。
- 执行 API build/lint、Mobile typecheck/build:weapp 与全仓 build。
