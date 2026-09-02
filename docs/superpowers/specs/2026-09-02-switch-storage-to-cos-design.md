# 对象存储切换至腾讯云 COS 设计

**日期：** 2026-09-02
**状态：** 已批准
**范围：** 将现有七牛上传、资产访问 URL 和 AI 生图持久化统一切换到腾讯云 COS。

## 决策

- COS 存储桶采用公有读、私有写。
- `COS_SECRET_ID` 与 `COS_SECRET_KEY` 仅保存在 API 环境变量中，永不下发客户端。
- Admin 和小程序先向已鉴权 API 申请 10 分钟有效的单对象 HTTPS PUT 地址，再直接上传 COS。
- 客户端读取公开资源时直接使用 `COS_BUCKET_DOMAIN/{key}`，无需云端密钥。
- 不保留七牛读取、写入或双存储兼容；七牛中的旧文件由用户另行处理。
- 对象 key 和 `StorageAsset` 数据结构保持不变，不需要数据库迁移。

## 实现

- `CosStorageService` 统一负责生成对象 key、签发 PUT 地址、拼接安全访问 URL 和上传服务端二进制。
- 删除七牛服务及其专属上传、访问 URL 接口。
- Admin 智能体头像上传改用 COS PUT，成功后继续登记 `StorageAsset`。
- `StorageAssetService` 返回 COS 访问 URL。
- AI 生图和参考图 key 读取统一使用 COS。
- 删除 `.env.example` 中的七牛配置说明，保留 COS 配置。
- 更新 OpenAPI 和移动端生成客户端，移除七牛专属契约。

## 安全边界

- 写权限只通过服务端签发的单对象、短时效 PUT URL 暴露。
- 上传地址必须为 HTTPS，并绑定确定的 `Content-Type`。
- 公开桶只存放头像、公开展示图等非敏感资源；私密音频或证件等内容后续使用独立私有桶，不放入本桶。
- `COS_BUCKET_DOMAIN` 只能是纯 HTTP(S) 域名；对象 key 拒绝相对路径、协议片段和绝对路径。

## 验证

- COS 凭证、URL 生成和服务端二进制上传单测。
- StorageAsset 与 AI 生图回归测试。
- API build、lint 和非 Temporal Jest。
- Admin build、lint。
- Mobile typecheck、OpenAPI/Orval 生成及全仓 build。
