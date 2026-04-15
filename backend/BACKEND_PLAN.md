# Litter-Bear Server 后端架构设计

## 1. 技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 运行时 | Node.js | ≥20 LTS | ESM 支持 |
| 框架 | NestJS | 11.x | 模块化架构、DI、Guard/Pipe/Interceptor |
| 语言 | TypeScript | 5.x | 严格模式 |
| ORM | Prisma | 6.x | Schema-first、类型安全、Migration |
| 数据库 | PostgreSQL | 16 | 主存储 |
| 缓存 | Redis | 7.x | Token 黑名单、Rate Limiting、会话缓存 |
| AI 框架 | Mastra | latest | Agent 编排、Tool 调用、流式响应 |
| 认证 | JWT | — | Access Token + Refresh Token |
| 验证 | class-validator + class-transformer | — | DTO 校验 |
| API 文档 | Swagger (@nestjs/swagger) | — | 自动生成 |
| 部署 | Docker Compose | — | PostgreSQL + Redis + App 一体编排 |
| 包管理 | pnpm | ≥9 | 与前端统一 |

---

## 2. 项目结构

```
Litter-Bear-Server/
├── prisma/
│   ├── schema.prisma            # 数据模型定义
│   └── migrations/              # 数据库迁移
├── src/
│   ├── main.ts                  # 入口
│   ├── app.module.ts            # 根模块
│   ├── common/                  # 公共层（框架级）
│   │   ├── decorators/          # @CurrentUser 等
│   │   ├── guards/              # JwtAuthGuard
│   │   ├── interceptors/        # ResponseInterceptor
│   │   └── filters/             # HttpExceptionFilter
│   ├── config/                  # 配置模块
│   │   ├── config.module.ts
│   │   └── env.validation.ts
│   ├── prisma/                  # Prisma 全局模块
│   │   ├── prisma.module.ts
│   │   └── prisma.service.ts
│   ├── redis/                   # Redis 全局模块
│   │   ├── redis.module.ts
│   │   └── redis.service.ts
│   └── modules/                 # 业务模块
│       ├── auth/                # 认证模块
│       │   ├── auth.module.ts
│       │   ├── auth.controller.ts
│       │   ├── auth.service.ts
│       │   ├── strategies/      # JWT Strategy
│       │   └── dto/
│       ├── user/                # 用户模块
│       │   ├── user.module.ts
│       │   ├── user.controller.ts
│       │   └── user.service.ts
│       ├── sms/                 # 短信验证码模块
│       │   ├── sms.module.ts
│       │   └── sms.service.ts
│       ├── conversation/        # 会话模块（待实现）
│       │   ├── conversation.module.ts
│       │   ├── conversation.controller.ts
│       │   ├── conversation.service.ts
│       │   └── dto/
│       ├── chat/                # 聊天模块 SSE（待实现）
│       │   ├── chat.module.ts
│       │   ├── chat.controller.ts
│       │   ├── chat.service.ts
│       │   └── dto/
│       └── ai/                  # Mastra AI 模块（待实现）
│           ├── ai.module.ts
│           ├── ai.service.ts
│           ├── agents/
│           └── tools/
├── test/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── nest-cli.json
├── tsconfig.json
├── tsconfig.build.json
└── package.json
```

---

## 3. 数据模型（Prisma Schema）

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String         @id @default(cuid())
  nickname      String         @default("用户")
  avatarUrl     String         @default("")
  phone         String?        @unique          // 手机号登录
  wechatOpenId  String?        @unique          // 微信 openid
  wechatUnionId String?        @unique          // 微信 unionid（可选）
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt
  conversations Conversation[]

  @@map("users")
}

model Conversation {
  id        String    @id @default(cuid())
  title     String    @default("新对话")
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  messages  Message[]
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([userId])
  @@map("conversations")
}

model Message {
  id             String       @id @default(cuid())
  role           MessageRole
  content        String       @db.Text
  status         MessageStatus @default(DONE)
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  createdAt      DateTime     @default(now())

  @@index([conversationId])
  @@map("messages")
}

enum MessageRole {
  USER
  ASSISTANT
}

enum MessageStatus {
  DONE
  ERROR
}

// 短信验证码（临时存储，也可纯用 Redis）
model SmsCode {
  id        String   @id @default(cuid())
  phone     String
  code      String
  expiresAt DateTime
  used      Boolean  @default(false)
  createdAt DateTime @default(now())

  @@index([phone, code])
  @@map("sms_codes")
}
```

---

## 4. API 设计

### 4.1 统一响应格式

```typescript
interface ApiResponse<T> {
  code: number;      // 业务状态码，200 = 成功
  data: T;
  message: string;
}
```

通过 `ResponseInterceptor` 自动包装所有非流式响应。

### 4.2 端点清单

#### Auth 模块

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/auth/wechat-login` | ❌ | 微信 code 换 token |
| POST | `/auth/phone/send-code` | ❌ | 发送手机验证码 |
| POST | `/auth/phone/login` | ❌ | 手机号 + 验证码登录 |
| POST | `/auth/refresh` | ❌ | Refresh Token 换新 Access Token |
| POST | `/auth/logout` | ✅ | 登出（Token 加入黑名单） |

**微信登录流程：**
1. 前端 `Taro.login()` 获取 code
2. 后端用 code 调微信 `code2Session` 接口换 openid + session_key
3. 查找或创建 User
4. 签发 JWT（Access Token 2h + Refresh Token 7d）

**手机号登录流程：**
1. 前端请求 `/auth/phone/send-code`，后端发短信验证码
2. 验证码存 Redis（5 分钟过期）+ DB 备份
3. 前端提交手机号 + 验证码到 `/auth/phone/login`
4. 校验通过后查找或创建 User，签发 JWT

#### User 模块

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/user/profile` | ✅ | 获取当前用户信息 |
| PATCH | `/user/profile` | ✅ | 更新昵称/头像 |

#### Conversation 模块

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/conversations` | ✅ | 获取用户所有会话（含消息） |
| POST | `/conversations` | ✅ | 创建新会话 |
| DELETE | `/conversations/:id` | ✅ | 删除会话 |

#### Chat 模块

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/chat/completions` | ✅ | SSE 流式聊天 |

---

## 5. SSE 流式响应设计

### 请求

```json
POST /chat/completions
{
  "conversationId": "xxx",
  "content": "你好"
}
```

### 响应（SSE 格式，兼容前端现有解析）

每条 SSE 事件包含标准字段：`id`、`event`、`data`。

```
id: 1
event: message
data: {"choices":[{"delta":{"content":"你"}}]}

id: 2
event: message
data: {"choices":[{"delta":{"content":"好"}}]}

id: 3
event: heartbeat
data: ""

id: 4
event: done
data: [DONE]
```

### 实现方式

```
Controller (SSE) → ChatService → AiService (Mastra Agent)
                                      ↓
                              Mastra streamText()
                                      ↓
                              AsyncGenerator<string>
                                      ↓
                        SSE Serializer (id + event + data)
```

- NestJS Controller 返回 `Observable` 或使用 `@Sse()` 装饰器
- Mastra Agent 的 `stream()` 返回异步迭代器
- 逐 chunk 转为 OpenAI 兼容格式推送
- 客户端断开时 abort Mastra stream

### 心跳机制

AI 生成期间可能出现较长的 token 间隔（尤其是 Tool 调用、思考阶段），为防止中间代理/网关误判超时断连，后端需要定期发送心跳事件。

| 配置项 | 值 | 说明 |
|--------|------|------|
| `SSE_HEARTBEAT_INTERVAL` | 15s | 心跳间隔（可通过环境变量配置） |
| 心跳事件类型 | `event: heartbeat` | 前端可识别并忽略 |
| 触发条件 | 自上次 data 推送超过 interval | 仅在空闲时发心跳，活跃推送时自动跳过 |
| 结束条件 | stream 完成或客户端断开 | 心跳定时器随 stream 生命周期销毁 |

**后端伪代码：**

```typescript
// chat.service.ts
async *streamWithHeartbeat(messages: CoreMessage[]): AsyncGenerator<SseEvent> {
  const heartbeatMs = this.configService.get('SSE_HEARTBEAT_INTERVAL', 15000);
  let eventId = 0;
  let lastSendTime = Date.now();

  // 心跳定时器：检查是否需要发送心跳
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastSendTime >= heartbeatMs) {
      pendingHeartbeat = true;
    }
  }, heartbeatMs);

  try {
    for await (const chunk of this.aiService.streamChat(messages)) {
      // 先发送可能积压的心跳
      if (pendingHeartbeat) {
        yield { id: String(++eventId), event: 'heartbeat', data: '' };
        pendingHeartbeat = false;
      }

      yield {
        id: String(++eventId),
        event: 'message',
        data: JSON.stringify({ choices: [{ delta: { content: chunk } }] }),
      };
      lastSendTime = Date.now();
    }

    yield { id: String(++eventId), event: 'done', data: '[DONE]' };
  } finally {
    clearInterval(heartbeatTimer);
  }
}
```

### 重连机制

SSE 连接可能因网络波动、Nginx 超时、手机切后台等原因中断。需要前后端配合实现无缝恢复。

#### 后端职责

| 设计点 | 方案 |
|--------|------|
| **事件 ID** | 每条 SSE 事件携带递增 `id` 字段 |
| **Last-Event-ID** | 读取请求头 `Last-Event-ID`，从断点续传 |
| **流式缓冲** | 每次 stream 的已发送事件暂存 Redis（key: `sse:{messageId}`, TTL: 5min） |
| **断点恢复** | 收到 `Last-Event-ID` 时，先重放缓冲中 > 该 ID 的事件，再继续实时流 |

#### 前端职责（需配合改造）

| 设计点 | 方案 |
|--------|------|
| **记录 lastEventId** | 每收到事件更新本地 `lastEventId` |
| **检测断连** | 监听连接关闭/错误事件 |
| **自动重连** | 断连后指数退避重试（1s → 2s → 4s，最大 30s） |
| **重连请求** | 携带 `Last-Event-ID` header + 原始 `conversationId` |
| **去重** | 根据事件 `id` 去重，避免重放内容重复追加 |

#### 重连时序图

```
Client                          Server                         Redis
  |                                |                              |
  |--- POST /chat/completions --->|                              |
  |                                |--- stream chunks ---------->|  缓存事件
  |<-- id:1 event:message --------|                              |
  |<-- id:2 event:message --------|                              |
  |                                |                              |
  |  ✕ 网络断开                     |                              |
  |                                |--- 检测断开, 暂停 stream ---->|
  |                                |                              |
  |  (指数退避等待)                  |                              |
  |                                |                              |
  |--- POST /chat/completions --->|                              |
  |    Last-Event-ID: 2           |                              |
  |    conversationId: xxx        |                              |
  |                                |--- 查询缓冲 id > 2 -------->|
  |                                |<-- 返回 id:3,4,5 事件 ------|
  |<-- id:3 event:message --------|  (重放缓冲)                   |
  |<-- id:4 event:message --------|                              |
  |<-- id:5 event:message --------|                              |
  |<-- id:6 event:message --------|  (继续实时流)                  |
  |<-- id:7 event:done -----------|                              |
  |                                |--- 清理缓冲 --------------->|
```

#### Redis 缓冲结构

```
Key:    sse:buffer:{messageId}
Type:   Sorted Set (ZSET)
Score:  eventId (递增整数)
Member: 序列化的 SSE event JSON
TTL:    5 分钟（stream 结束后自动过期）
```

```typescript
// redis 操作示例
await redis.zadd(`sse:buffer:${msgId}`, eventId, JSON.stringify(event));
// 重连时获取断点后的事件
const missed = await redis.zrangebyscore(`sse:buffer:${msgId}`, lastEventId + 1, '+inf');
```

#### 边界情况处理

| 场景 | 处理 |
|------|------|
| 缓冲已过期（断连 > 5min） | 返回 `event: expired`，前端标记该消息为 error，提示用户重新发送 |
| Stream 已完成后重连 | 从缓冲重放剩余事件 + `done`，无需重启 AI |
| 多次快速重连 | 以 `Last-Event-ID` 为准去重，幂等安全 |
| 客户端未发 Last-Event-ID | 视为全新请求，正常走新建 stream 流程 |

---

## 6. Mastra AI 集成

### 架构

```
src/ai/
├── ai.module.ts
├── ai.service.ts           # 初始化 Mastra、暴露 stream 方法
├── agents/
│   └── chat-agent.ts       # 聊天 Agent 定义
└── tools/
    └── (预留：搜索、图片生成等)
```

### Agent 定义

```typescript
// chat-agent.ts
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";  // 或其他 provider

export const chatAgent = new Agent({
  name: "LitterBear",
  instructions: "你是 Litter Bear，一个友好的 AI 助手...",
  model: openai("gpt-4o-mini"),  // 可配置
});
```

### AiService

```typescript
@Injectable()
export class AiService {
  private mastra: Mastra;

  constructor() {
    this.mastra = new Mastra({ agents: { chatAgent } });
  }

  async *streamChat(messages: CoreMessage[]): AsyncGenerator<string> {
    const agent = this.mastra.getAgent("chatAgent");
    const stream = await agent.stream(messages);
    for await (const chunk of stream.textStream) {
      yield chunk;
    }
  }
}
```

---

## 7. 认证与安全

### JWT 策略

- **Access Token**: 2 小时有效，存前端 localStorage
- **Refresh Token**: 7 天有效，用于无感续期
- **Token 黑名单**: 登出时将 Access Token 加入 Redis 黑名单（TTL = 剩余有效期）

### Guard 链路

```
Request → JwtAuthGuard → @CurrentUser() decorator → Controller
```

### Rate Limiting

- `/auth/phone/send-code`: 60 秒 1 次（同手机号）
- `/chat/completions`: 每用户 10 req/min
- 使用 `@nestjs/throttler` + Redis store

---

## 8. Redis 用途

| Key 模式 | 用途 | TTL |
|-----------|------|-----|
| `sms:{phone}` | 短信验证码 | 5 min |
| `sms:limit:{phone}` | 发送频率限制 | 60s |
| `token:blacklist:{jti}` | Token 黑名单 | Token 剩余有效期 |
| `rate:{userId}:{endpoint}` | 接口限流计数 | 1 min |
| `sse:buffer:{messageId}` | SSE 事件缓冲（ZSET，用于断线重连重放） | 5 min |

---

## 9. 环境变量

```env
# App
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/litter_bear

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# JWT
JWT_ACCESS_SECRET=your-access-secret
JWT_REFRESH_SECRET=your-refresh-secret
JWT_ACCESS_EXPIRES_IN=2h
JWT_REFRESH_EXPIRES_IN=7d

# WeChat
WECHAT_APP_ID=your-app-id
WECHAT_APP_SECRET=your-app-secret

# AI (Mastra)
OPENAI_API_KEY=your-openai-key
AI_MODEL=gpt-4o-mini

# SSE
SSE_HEARTBEAT_INTERVAL=15000
SSE_BUFFER_TTL=300

# SMS（短信服务商，如阿里云/腾讯云）
SMS_ACCESS_KEY_ID=
SMS_ACCESS_KEY_SECRET=
SMS_SIGN_NAME=
SMS_TEMPLATE_CODE=
```

---

## 10. Docker Compose

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/litter_bear
      - REDIS_HOST=redis
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: litter_bear
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pg_data:
  redis_data:
```

---

## 11. 开发命令

```bash
# 启动
pnpm start:dev          # 开发模式（热重载）
pnpm start:debug        # 调试模式
pnpm start:prod         # 生产模式

# 构建
pnpm build              # 编译项目

# 数据库迁移
pnpm db:migrate         # 创建并应用迁移
pnpm db:migrate:create  # 仅生成迁移 SQL，不执行
pnpm db:migrate:deploy  # 生产环境应用迁移
pnpm db:migrate:reset   # 重置数据库（删除所有数据重建）
pnpm db:generate        # 重新生成 Prisma Client
pnpm db:studio          # 打开 Prisma Studio 可视化管理
pnpm db:seed            # 执行种子数据
pnpm db:push            # 直接推送 schema 到数据库（跳过迁移）

# Docker
docker compose up -d db redis   # 启动 PostgreSQL + Redis
docker compose down             # 停止所有容器
docker compose ps               # 查看容器状态

# 代码质量
pnpm lint               # ESLint 检查 + 修复
pnpm format             # Prettier 格式化
pnpm test               # 运行单元测试
pnpm test:e2e           # 运行 E2E 测试
```

---

## 12. 开发阶段规划

### Phase 1 — 基础骨架
- [x] NestJS 项目初始化
- [x] Docker Compose（PostgreSQL + Redis）
- [x] Prisma Schema + 初始迁移
- [x] 统一响应拦截器 + 异常过滤器
- [x] 配置模块（环境变量校验）

### Phase 2 — 认证体系
- [x] 微信登录（code2Session + JWT 签发）
- [x] 手机号验证码登录
- [x] JWT Guard + @CurrentUser 装饰器
- [x] Token 刷新 + 黑名单

### Phase 3 — 核心业务
- [x] 会话 CRUD
- [x] Mastra Agent 集成
- [x] SSE 流式聊天端点
- [x] 消息持久化

### Phase 4 — 增强功能 ✅
- [x] Rate Limiting（@nestjs/throttler + Redis 存储，全局 60 req/min）
- [x] 语音消息处理（OpenAI Whisper 转文字 → SSE 流式回复）
- [x] AI 图片生成端点（DALL-E 3，POST /chat/image-generations）

### Phase 5 — 生产就绪 ✅
- [x] Swagger 文档（所有 DTO 添加 @ApiProperty）
- [x] 健康检查端点（GET /health，@nestjs/terminus + DB/Redis 检查）
- [x] 日志体系（nestjs-pino 结构化日志，开发环境 pino-pretty）
- [x] Dockerfile 多阶段构建优化（prisma generate）
- [x] CI/CD Pipeline（GitHub Actions：lint → tsc → test → build）
