# 腾讯云 COS 小程序直传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增腾讯云 COS 小程序直传能力，同时完整保留七牛上传、资产登记与后台头像上传链路。

**Architecture:** API 使用官方 `cos-nodejs-sdk-v5` 为当前用户生成的单一 object key 签发短期 HTTPS `PUT` URL。小程序读取本地文件为 `ArrayBuffer` 后直接 PUT 到 COS；API 不代理二进制，客户端不获得 COS 密钥。COS 保持独立接口与工具，不接入当前仅支持七牛的 `StorageAsset` 表。

**Tech Stack:** NestJS 11、`@nestjs/config`、`cos-nodejs-sdk-v5`、Taro 4、TypeScript、Jest、Orval。

---

## 文件结构

- `apps/api/src/modules/storage/cos-storage.service.ts`：生成 key、校验 COS 配置、签发单对象 PUT URL 与访问 URL。
- `apps/api/src/modules/storage/cos-storage.service.spec.ts`：服务端配置与凭证行为测试。
- `apps/api/src/modules/storage/dto/cos-upload-credential.dto.ts`：COS 凭证响应 DTO。
- `apps/api/src/modules/storage/storage.controller.ts`：新增独立 COS 凭证路由，保留所有七牛路由。
- `apps/api/src/modules/storage/storage.module.ts`：注册并导出 COS service。
- `apps/api/src/config/env.validation.ts`、`apps/api/.env`、`apps/api/.env.example`：声明并提供 COS 配置占位。
- `apps/api/package.json`、`pnpm-lock.yaml`：添加官方 COS SDK。
- `apps/api/docs/openapi.json`、`apps/mobile/src/api/generated/**`：由现有 OpenAPI/Orval 命令生成，禁止手工修改。
- `apps/mobile/src/utils/cos-upload.ts`：小程序获取凭证、读取 `ArrayBuffer`、PUT 直传和非 2xx 错误处理。

### Task 1: COS 凭证服务与环境配置

**Files:**
- Create: `apps/api/src/modules/storage/cos-storage.service.ts`
- Create: `apps/api/src/modules/storage/cos-storage.service.spec.ts`
- Modify: `apps/api/src/config/env.validation.ts`
- Modify: `apps/api/.env`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: 添加依赖并定义失败测试**

在 `cos-storage.service.spec.ts` 中构造仅提供 `get()` 的 `ConfigService` mock。测试应先引用尚不存在的 `CosStorageService`，验证以下行为：

```ts
it('签发固定 key 的 PUT URL，且将 Content-Type 返回给小程序', async () => {
  const credential = await service.createUploadCredential(
    'user-1',
    'image',
    'png',
  );

  expect(credential.key).toMatch(/^image\/\d{6}\/user-1\/[0-9a-f]{32}\.png$/);
  expect(credential.uploadUrl).toContain('Signature=');
  expect(credential.headers).toEqual({ 'Content-Type': 'image/png' });
  expect(credential.accessUrl).toContain(credential.key);
});

it('缺少 COS 配置时只抛出可操作的 503', async () => {
  const unconfigured = createService({ COS_SECRET_ID: undefined });
  await expect(
    unconfigured.createUploadCredential('user-1', 'audio', 'mp3'),
  ).rejects.toThrow('COS 对象存储未配置');
});
```

将官方依赖加入 API workspace：

```bash
pnpm --filter ./apps/api add cos-nodejs-sdk-v5
```

- [ ] **Step 2: 运行定向测试，确认因服务缺失而失败**

Run:

```bash
pnpm --filter ./apps/api exec jest --runInBand --watchman=false src/modules/storage/cos-storage.service.spec.ts
```

Expected: FAIL，原因是 `CosStorageService` 或对应模块尚不存在，而非 TypeScript 配置错误。

- [ ] **Step 3: 实现最小 COS 服务和配置声明**

`CosStorageService` 使用 `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_BUCKET`、`COS_REGION`、`COS_BUCKET_DOMAIN`；仅在调用 `createUploadCredential()` 时校验，任一缺失抛 `ServiceUnavailableException`。每个新方法提供中文 JSDoc，明确入参、返回值和作用。

```ts
async createUploadCredential(
  userId: string,
  type: UploadMediaType,
  ext: string,
): Promise<CosUploadCredential> {
  const { bucket, region, domain } = this.requireConfig();
  const key = this.buildObjectKey(type, userId, ext);
  const contentType = this.resolveContentType(type, ext);
  const uploadUrl = await this.getSignedPutUrl({ bucket, region, key, contentType });

  return {
    key,
    uploadUrl,
    accessUrl: `${domain}/${encodeURI(key)}`,
    headers: { 'Content-Type': contentType },
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
}
```

实现中使用 COS SDK 的 `getObjectUrl` 签名 `PUT` 方法，签名有效期为 600 秒，key 格式沿用现有七牛的按月、按用户隔离格式。`COS_BUCKET_DOMAIN` 仅用于拼接上传成功后的访问 URL；该域名需要是可访问的 COS 或 CDN 域名。环境变量在 `.env` 与 `.env.example` 均写空值，不写真实凭据。

- [ ] **Step 4: 运行定向测试确认变绿**

Run:

```bash
pnpm --filter ./apps/api exec jest --runInBand --watchman=false src/modules/storage/cos-storage.service.spec.ts
```

Expected: PASS，覆盖预签名 URL、key 隔离、Content-Type 和缺配置 503。

### Task 2: 暴露独立 COS 上传凭证接口并生成契约

**Files:**
- Create: `apps/api/src/modules/storage/dto/cos-upload-credential.dto.ts`
- Modify: `apps/api/src/modules/storage/storage.controller.ts`
- Modify: `apps/api/src/modules/storage/storage.module.ts`
- Modify: `apps/api/docs/openapi.json`
- Modify: `apps/mobile/src/api/generated/**`

- [ ] **Step 1: 编写控制器失败测试或补充现有模块测试**

为 `StorageController` 创建最小单测，断言 `POST /storage/cos/upload-credential` 将当前用户及 COS 独立 DTO 的 `type`、`ext` 传递给 `CosStorageService`，且不会调用 `QiniuStorageService`。

```ts
expect(cosStorageService.createUploadCredential).toHaveBeenCalledWith(
  'user-1',
  'image',
  'png',
);
expect(qiniuStorageService.createUploadCredential).not.toHaveBeenCalled();
```

- [ ] **Step 2: 验证路由尚不存在**

Run:

```bash
pnpm --filter ./apps/api exec jest --runInBand --watchman=false src/modules/storage/storage.controller.spec.ts
```

Expected: FAIL，原因是控制器没有 COS service 注入或方法不存在。

- [ ] **Step 3: 添加 DTO、路由与模块 provider**

响应 DTO 显式返回 `key`、`uploadUrl`、`accessUrl`、`headers` 和毫秒级 `expiresAt`。控制器新增路由但不修改 `POST /storage/upload-credential`：

```ts
@Post('cos/upload-credential')
@ApiOperation({
  summary: '签发腾讯云 COS 小程序直传凭证',
  description: '返回单对象、短期有效的 PUT URL；文件不经过本服务。',
})
@ApiOkResponse({ type: CosUploadCredentialResponseDto })
createCosUploadCredential(
  @CurrentUser('id') userId: string,
  @Body() dto: CosUploadCredentialDto,
): Promise<CosUploadCredentialResponseDto> {
  return this.cosStorageService.createUploadCredential(
    userId,
    dto.type,
    dto.ext,
  );
}
```

在 `StorageModule` 注册/导出 `CosStorageService`。导出 OpenAPI 并在小程序目录生成客户端：

```bash
pnpm --filter ./apps/mobile generate:api:local
```

- [ ] **Step 4: 运行控制器测试确认变绿**

Run:

```bash
pnpm --filter ./apps/api exec jest --runInBand --watchman=false src/modules/storage/storage.controller.spec.ts
```

Expected: PASS，COS 路由只调用 COS service；原七牛路由不变。

### Task 3: 小程序 COS PUT 上传工具

**Files:**
- Create: `apps/mobile/src/utils/cos-upload.ts`
- Create: `apps/mobile/src/utils/cos-upload.test.ts`
- Modify: `apps/mobile/package.json`

- [ ] **Step 1: 写出文件读取与非成功状态的失败测试**

将 URL/状态校验提取为纯函数，并为文件读取 Promise 注入最小回调式 `readFile` mock，避免在单测中依赖微信运行时：

```ts
it('COS 返回非 2xx 时抛出包含状态码的错误', () => {
  expect(() => assertCosUploadSucceeded(403)).toThrow('COS 上传失败(403)');
});

it('COS 返回 204 时视为上传成功', () => {
  expect(() => assertCosUploadSucceeded(204)).not.toThrow();
});

it('文件系统返回 ArrayBuffer 时解析上传二进制', async () => {
  await expect(readFileAsArrayBuffer('/tmp/image.png', mockReadFile(new ArrayBuffer(1)))).resolves.toBeInstanceOf(ArrayBuffer);
});

it('文件系统返回字符串或失败时拒绝上传', async () => {
  await expect(readFileAsArrayBuffer('/tmp/image.png', mockReadFile('text'))).rejects.toThrow('不是二进制数据');
  await expect(readFileAsArrayBuffer('/tmp/image.png', mockReadFileError('读取失败'))).rejects.toThrow('读取失败');
});
```

在 `apps/mobile/package.json` 增加 `test:cos`，沿用现有 `test:agent` 的独立 TypeScript 编译后 Node 执行方式。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm --filter ./apps/mobile run test:cos
```

Expected: FAIL，原因是 `assertCosUploadSucceeded` 尚未实现。

- [ ] **Step 3: 实现上传工具**

工具只使用 Orval 生成的 `storageControllerCreateCosUploadCredential`，不手写 API 路径或旧接口字段。当前 Taro 的 `FileSystemManager.readFile` 是回调 API，必须先封装为 Promise；COS 的 200/204 空响应也不能复用会追加 Bearer Token、默认 JSON Content-Type 并解包业务信封的 `BaseApiClient`：

```ts
function readFileAsArrayBuffer(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().readFile({
      filePath,
      success: ({ data }) => {
        if (data instanceof ArrayBuffer) {
          resolve(data);
          return;
        }
        reject(new Error('COS 上传文件读取结果不是二进制数据'));
      },
      fail: (error) => reject(new Error(error.errMsg || '读取上传文件失败')),
    });
  });
}

export async function uploadToCos(input: CosUploadInput): Promise<CosUploadedObject> {
  const credential = await storageControllerCreateCosUploadCredential({
    type: input.type,
    ext: input.ext,
  });
  const data = await readFileAsArrayBuffer(input.filePath);
  const response = await Taro.request({
    url: credential.uploadUrl,
    method: 'PUT',
    data,
    header: credential.headers,
  });
  assertCosUploadSucceeded(response.statusCode);
  return { key: credential.key, url: credential.accessUrl };
}
```

小程序必须原样透传服务端签名的 `Content-Type`，不得覆盖上传 URL query、添加 Authorization 或 JSON 默认请求头。当文件系统未返回 `ArrayBuffer` 时抛明确错误；绝不改写现有七牛上传工具或将 COS key 送入 `POST /storage/assets`。

- [ ] **Step 4: 运行小程序定向测试与类型检查**

Run:

```bash
pnpm --filter ./apps/mobile run test:cos
pnpm --filter ./apps/mobile run typecheck
```

Expected: PASS。

### Task 4: 整体验证与审查

**Files:**
- Verify: COS 相关改动及生成客户端

- [ ] **Step 1: 执行后端验证**

```bash
pnpm --filter ./apps/api exec jest --runInBand --watchman=false src/modules/storage/cos-storage.service.spec.ts src/modules/storage/storage.controller.spec.ts
pnpm --filter ./apps/api run lint:check
pnpm --filter ./apps/api run build
```

Expected: 所有命令退出码为 0。

- [ ] **Step 2: 执行小程序构建与锁文件校验**

```bash
pnpm --filter ./apps/mobile run test:cos
pnpm --filter ./apps/mobile run typecheck
pnpm --filter ./apps/mobile run build:weapp
pnpm install --lockfile-only --frozen-lockfile --ignore-scripts --offline
git diff --check
```

Expected: 所有命令退出码为 0；构建无需真实 COS 配置或云端访问。

- [ ] **Step 3: 子代理交叉复核**

一名子代理审查服务端签名、配置校验和七牛隔离；另一名审查小程序 PUT、`ArrayBuffer` 类型和未登记 COS 资源的边界。主线读取结论、修复可复现问题并复跑受影响验证。

## 计划自检

- 覆盖范围：服务端 COS 签名、环境变量、独立接口、Orval 契约、小程序 PUT 工具、验证与交叉复核均有对应任务。
- 非目标：七牛端点、后台头像上传和 `StorageAsset` 未列入修改任务。
- 一致性：接口路径统一为 `/storage/cos/upload-credential`，响应字段统一为 `key`、`uploadUrl`、`accessUrl`、`headers`、`expiresAt`。
- 约束：不在 `.env` 或文档中写入真实 COS 凭据；无数据库 schema 改动和迁移。
