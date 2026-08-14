# 腾讯云 COS 小程序直传设计

## 目标

在不替换或修改现有七牛上传通道的前提下，新增腾讯云 COS 的小程序直传能力。服务端只签发单对象、短期有效的预签名上传 URL；对象二进制不经过 API 服务，密钥也不会下发到客户端。

## 范围与非目标

- 新增独立的 COS 上传凭证接口和小程序上传工具。
- 七牛的上传凭证、访问 URL、后台头像上传及资源登记链路保持不变。
- 本次不修改 `StorageAsset` 数据模型或登记接口。它当前将 key 解析为七牛访问 URL，混入 COS 对象会导致资源 URL 错配。
- 本次不引入 COS 临时密钥（STS）、断点续传或分片上传；媒体大小沿用现有小程序侧选择和校验范围。

## 接口与数据流

1. 小程序提供媒体类型和扩展名给 `POST /storage/cos/upload-credential`。
2. API 根据当前用户生成与七牛一致的归属 key：`{image|audio}/{yyyyMM}/{userId}/{uuid}.{ext}`。
3. API 使用官方 COS SDK 为该 key 签发 10 分钟有效的 HTTPS `PUT` URL，并将 MIME 类型纳入签名；响应携带 `key`、`uploadUrl`、`accessUrl`、`expiresAt` 和直传所需请求头。
4. 小程序将回调式文件系统读取封装为 Promise，读取本地文件为 `ArrayBuffer`，再直接使用 `Taro.request` 对 `uploadUrl` 执行 `PUT`。该请求不复用 API 请求封装，不携带 Bearer Token，也不解析业务响应包；上传完成后返回 API 预先计算的 `key` 和 `accessUrl` 给调用方。

上传 URL 只允许写入后端已生成的单一 key，过期后不可再使用。MIME 类型仅由服务端的受限 `type/ext` 映射决定并纳入签名，小程序只原样透传响应中的请求头。小程序必须把每个 `uploadUrl` 可能使用的 COS HTTPS 主机名加入微信公众平台的 request 合法域名；若用 `accessUrl` 展示或下载资源，应将对应 CDN 域名加入 downloadFile 合法域名，只有代码用 `Taro.request` 访问 CDN 时才需加入 request 合法域名。

## 配置

新增以下 API 环境变量，并同时写入 `apps/api/.env` 和 `apps/api/.env.example` 的空占位：

- `COS_SECRET_ID`
- `COS_SECRET_KEY`
- `COS_BUCKET`：腾讯云 COS bucket 名，包含 appid 后缀。
- `COS_REGION`
- `COS_BUCKET_DOMAIN`：访问域名；可使用 COS 默认域名或自定义 CDN 域名。

COS 服务按调用时读取并校验配置。任何必填项未配置，或 bucket/region 格式非法时，仅 COS 上传凭证接口返回可操作的 503；既有七牛流程与服务启动均不受影响。

## 错误处理与验证

- COS 独立 DTO 限制媒体类型和扩展名，服务端复用与七牛一致的 key 规则。
- 小程序在读取文件、签发凭证或 COS 返回非 2xx 时抛出带状态码的错误，不伪造上传成功；非微信小程序环境和非 `ArrayBuffer` 文件内容也明确失败。
- 单测覆盖 COS key 归属、预签名请求参数、配置缺失 503 和小程序请求形状。
- 验证 API 定向测试、lint、build 和小程序 typecheck/build；不因未填写真实 COS 配置访问云端。
