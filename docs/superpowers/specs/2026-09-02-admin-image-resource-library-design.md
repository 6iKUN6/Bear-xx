# Admin 图片资源库设计

**日期：** 2026-09-02
**状态：** 已实现
**范围：** 在管理后台统一浏览、上传和治理所有已登记图片资源。
**不包含：** 音频资源、COS 物理删除、文件夹与标签、资源引用关系、批量状态操作、编辑既有资源用途。

## 目标

在现有 `StorageAsset` 登记簿和腾讯云 COS 预签名直传能力上增加一个图片资源库，使 `ADMIN` 与 `SUPER_ADMIN` 可以：

- 浏览智能体头像、聊天图片、AI 生图和后台上传的通用图片。
- 按原文件名或对象 key 搜索，按用途和状态筛选，并通过服务端分页处理持续增长的数据量。
- 批量上传图片，查看每张图片的独立进度和失败原因。
- 预览图片、复制访问链接、下载文件、软删除资源以及恢复资源。

资源库只管理已登记资产。COS 对象 key 仍是存储位置的唯一事实源，访问 URL 继续由当前域名和 key 运行时生成。

## 已确认决策

- 页面展示全部已登记图片，不展示音频。
- 删除只将资产状态改为 `DELETED`，不删除数据库记录和 COS 对象，避免破坏历史消息或智能体引用。
- 页面支持多选与拖拽批量上传，每张图片独立展示状态和错误。
- 人工上传时选择用途，默认“通用图片”，也可选择“智能体头像”。
- 通用图片最大 10MB，智能体头像最大 2MB；后台上传只支持 JPG、PNG、WebP 和 GIF。
- 资源列表使用服务端分页，每页 24 张，支持用途、状态和原文件名/key 搜索。
- 页面采用图片库优先布局，上传在独立弹窗内完成。
- `ADMIN` 与 `SUPER_ADMIN` 拥有相同的查看、上传、复制、下载、软删除和恢复权限。
- 沿用现有 `StorageAsset`，不新建第二套媒体库模型。

## 数据模型

### StorageAsset

新增可空字段：

```txt
originalName String? @map("original_name")
```

新上传资源保存浏览器提供的原文件名。历史记录保持 `null`；管理界面在该字段为空时显示对象 key 的最后一段，不伪造未知原名。

字段只用于展示、搜索和下载命名，不参与 COS key 拼接。服务端限制长度并将其作为普通文本处理，避免路径注入或同名覆盖。

### 业务用途

`STORAGE_USAGES` 增加：

```txt
shared-image
```

后台人工上传允许选择：

- `shared-image`：通用图片，默认值，最大 10MB。
- `agent-avatar`：智能体头像，最大 2MB。

已有 `chat-image` 与 `ai-image` 只用于展示和筛选，不作为后台人工上传选项。`voice-input` 属于音频，不出现在本页面。

## API 边界

管理后台只消费 `/admin/*`，新增 Admin 专用存储端点：

```txt
POST  /admin/storage/upload-credential
POST  /admin/storage/assets
GET   /admin/storage/assets
PATCH /admin/storage/assets/:id/status
```

现有小程序和其他终端使用的 `/storage/*` 上传端点保持不变。Admin 专用 Controller 复用现有 `CosStorageService` 与 `StorageAssetService`，不复制签名或登记逻辑。

### 上传凭证

请求包含图片扩展名、用途和声明文件大小。服务端校验：

- 用途只能是 `shared-image` 或 `agent-avatar`。
- 扩展名只能是 `jpg/jpeg/png/webp/gif`。
- 声明大小必须大于 0，且不超过对应用途上限。

校验通过后仍由 `CosStorageService` 为单一随机 key 签发十分钟有效的 HTTPS PUT URL。文件二进制不经过 API 服务。

### 资产登记

登记请求包含凭证返回的 key、用途、真实浏览器文件大小、MIME 类型和原文件名。现有 key 归属校验与幂等 upsert 保持有效；重复登记同一 key 时可以补全元数据，但不能修改 kind 或上传者归属。

### 图片列表

查询参数：

```txt
page      默认 1
pageSize  默认 24，最大 100
search    可选，匹配 originalName 或 key
usage     可选
status    可选
```

资源库请求固定过滤 `kind=IMAGE`，按创建时间和 id 倒序。响应为：

```txt
items
page
pageSize
total
totalPages
```

页面默认显式请求 `status=ACTIVE`。选择“全部状态”时不传 status，使后端返回所有状态。

### 状态更新

管理界面只执行：

- `ACTIVE -> DELETED`
- `BROKEN -> ACTIVE`
- `DELETED -> ACTIVE`

不提供 COS 物理删除。图片加载失败也不会自动写入 `BROKEN`，避免短暂 CDN 故障污染持久状态。

## 页面设计

Admin 新增 `/resources` 路由和“图片资源”导航入口。

### 页面头部

- 标题与当前查询总数。
- 原文件名/key 搜索框。
- 用途筛选：全部、通用图片、智能体头像、聊天图片、AI 生图。
- 状态筛选：可用、失效、已删除、全部。
- 刷新图标按钮和“上传图片”主按钮。

### 图片网格

每页展示 24 张，缩略图使用稳定宽高比，避免图片加载改变布局。卡片展示：

- 图片缩略图。
- 原文件名；历史数据没有原名时显示 key 末段。
- 用途、文件大小、状态和创建时间。
- 预览、复制链接、下载、软删除或恢复操作。

操作使用图标按钮并提供 tooltip 或原生 title。状态不是 `ACTIVE` 时降低缩略图视觉权重，但仍展示真实状态。

### 预览弹窗

预览弹窗展示适配容器的大图，并列出完整 key、访问 URL、MIME、大小、用途、状态与创建时间。长 key 和 URL 可换行或复制，不撑破弹窗。

### 上传弹窗

上传弹窗先选择用途，再通过拖拽或文件选择器加入多张图片。文件进入队列前校验格式和大小，不合格文件直接显示具体原因。

最多同时处理三张图片。每张图片的状态独立流转：

```txt
等待 -> 获取凭证 -> 上传 COS -> 登记资产 -> 成功
                            \-> 失败
```

单张失败不影响其他图片。失败项保留错误并提供单独重试；上传中阻止关闭弹窗。成功登记后失效当前资源列表查询。

## 失败与重试

- 凭证签发失败：重试时重新请求凭证。
- COS PUT 失败：不登记资产，显示响应摘要，重试时重新开始该文件。
- COS PUT 成功但登记失败：保留已经上传的 key；重试只重新登记，不再次上传文件。
- 列表失败：显示错误状态和重试按钮，不显示为空资源库。
- 缩略图加载失败：展示加载失败占位，不自动修改资产状态。
- 复制、下载、删除和恢复：分别反馈真实成功或失败结果。
- 删除后当前页无记录且页码大于 1：退回上一页，避免停在空白分页。

下载由浏览器读取资源 URL 并生成带原文件名的临时下载链接。COS/CDN 若拒绝跨域读取，页面明确提示下载失败，不改成伪成功或静默打开新窗口。

## 缓存与状态

资源查询 key 包含页码、搜索、用途和状态。上传登记、删除和恢复成功后失效所有资源列表查询；分页与筛选仍保留在页面状态中。

上传队列使用页面本地状态管理，不进入全局 store。每个队列项保存文件、用途、阶段、凭证 key 和错误，使登记阶段失败后可以精确重试。

## 验证

后端定向测试覆盖：

- Admin 凭证用途、扩展名和大小限制。
- 原文件名登记及历史空值投影。
- 图片 kind 过滤、分页、原文件名/key 搜索、用途和状态过滤。
- 软删除与恢复。
- `ADMIN` 与 `SUPER_ADMIN` 路由权限。

Admin 验证覆盖：

- 文件格式和用途大小限制。
- 批量队列的并发上限与独立失败。
- PUT 成功但登记失败时只重试登记。
- 查询参数、缓存失效和分页回退。
- 页面加载、空状态、错误状态和操作反馈。

实现完成后执行：

```bash
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check
cd apps/api
npx jest src/modules/storage src/modules/admin/admin-storage.controller.spec.ts --runInBand --no-watchman
pnpm --filter ./apps/admin run typecheck
pnpm --filter ./apps/admin run lint
pnpm --filter ./apps/admin run build
```

Prisma schema 发生变化，迁移由用户本地运行：

```bash
pnpm --filter ./apps/api run db:migrate
```

实现阶段只修改 `schema.prisma`，不手写或修改 `migration.sql`；最终交付时给出建议 migration name。
