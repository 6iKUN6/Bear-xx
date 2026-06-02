# AGENT.md

## 目的

本文件用于约束在 `Litter-Bear-Server` 仓库内进行开发、重构、修复和联调时的基本规范。

目标：

- 保持接口行为稳定
- 保持数据库变更可追踪
- 保持 SSE 任务模型一致
- 降低随手改动导致的前后端联调成本

这是一份初版规范，后续可以继续补充和收紧。

## 项目概况

当前项目是一个基于 NestJS 的后端服务，核心技术栈如下：

- `NestJS 11`
- `Prisma + PostgreSQL`
- `Redis + ioredis`
- `JWT + Passport`
- `Swagger`
- `nestjs-pino`
- `LangChain/OpenAI`

当前已落地的主要业务模块：

- 认证：微信登录、手机号验证码登录、刷新 token、登出
- 用户：查询和更新资料
- 会话：创建、列表、删除
- 聊天：创建聊天任务、语音转写任务、图片生成
- SSE 任务：状态查询、浏览器流式连接、微信小程序恢复、取消任务
- 健康检查

## 开发原则

### 1. 先看现状再改

在做任何功能或修复前，先阅读相关 controller、service、dto、schema 和 migration。

不要只看文档或注释推断行为，以代码现状为准。

### 2. 优先最小可控变更

优先做局部、可验证的修改：

- 修复 bug 时不要顺手大改 unrelated 结构
- 重构时先保持接口兼容
- 若必须改接口或数据结构，先在变更说明中写清楚影响面

### 3. 不允许“半实现”直接冒充完成

如果某个接口已经暴露但核心逻辑未闭环，应明确标注限制，不要在文档或说明里写成“已完成”。

典型例子：

- 任务状态定义了，但没有真实写入状态流转
- 暴露了恢复接口，但底层 producer 实际不能恢复
- 新增了 task type，但执行分支没有实现

### 4.备注
在新增一个新的方法或者函数时，需要对函数或者方法提供详细的备注。备注内容需要有入参和出参、作用和简要描述。（除了参数名外都使用中文）

例子：

/**
 * 根据任务ID和用户ID获取任务状态
 * @param taskId 任务ID
 * @param userId 用户ID
 * @returns 返回包含任务详情信息的对象，包括状态、会话ID、最后事件ID等
 * @description 查询指定ID的SSE任务状态。如果不存在将抛出异常。
 */
async getTaskStatus(taskId: string, userId: string): Promise<TaskStatusDto> {
  // ...
}

### 5. 提交信息

Git 提交信息统一使用中文，标题和正文都不使用英文描述核心变更。

约束如下：

- 提交标题必须直接表达本次变更的业务语义或技术语义
- 提交正文应说明本次改动的核心点和影响范围
- 不要使用只有作者自己能看懂的缩写或模糊描述
- 如果一次提交同时包含重构和修复，应在正文里写清楚主次关系

## 目录约定

### 1. 模块目录

业务模块放在 `src/modules/<module-name>/` 下，通常包含：

- `*.controller.ts`
- `*.service.ts`
- `*.module.ts`
- `dto/`

### 2. 通用能力

通用能力放在以下目录：

- `src/common/`：装饰器、拦截器、过滤器、SSE 通用定义
- `src/prisma/`：Prisma module 与 service
- `src/redis/`：Redis module 与 service
- `src/config/`：配置与环境校验

### 3. 文档

架构设计、协议说明、联调说明等放在根目录 `docs/`。

当某个设计已经明显超出“代码自解释”的范围时，应补一份文档，而不是把说明塞进长注释里。

## 代码风格

### 1. 语言与风格

- 使用 TypeScript
- 保持现有 NestJS 风格和依赖注入方式
- 尽量使用明确命名，少用模糊缩写
- 不写无意义注释

### 2. DTO 与校验

所有入参 DTO 应使用 `class-validator` 和 `class-transformer`。

新增接口时：

- 必须补 DTO
- 必须加校验规则
- 应补 `@nestjs/swagger` 注解

接口返回结构发生变化时，也应同步补充或更新返回 DTO 与 Swagger response 注解，避免前端 Orval 生成出不准确的类型。

不要为了省事在 Controller 上使用过宽的 `Object`、`Record<string, any>` 或匿名对象作为长期返回类型；确实是临时实现时，应在说明中明确限制。

### 3. Controller 和 Service 分层

约束如下：

- Controller 负责路由、鉴权、参数接收、返回值形状
- Service 负责核心业务逻辑
- 不要把复杂业务直接堆进 Controller

### 4. 模块设计与重构

新增模块或重构现有模块时，必须优先满足以下约束：

- 优先保证可读性、语义化命名和清晰边界
- 优先减少不必要的中间层，避免为未来假想扩展提前堆抽象
- 一个模块只保留当前业务真正需要的层级，不保留无人使用的兼容壳或历史残留
- 如果一个抽象层只有一个实现，且短期内没有真实第二实现需求，优先内聚到单一 service，而不是拆成 token、adapter、factory 多层
- 方法名必须表达真实语义，不要用“resume”同时承担“首次启动”和“恢复续流”两种语义，不要用“completion”掩盖“仅创建任务”这种行为
- 重构时优先压缩调用链路长度，避免出现“controller -> facade -> service -> manager -> adapter -> provider”这类过深链路
- 对外暴露的接口和内部执行入口必须语义一致；如果一个方法承担了多种职责，应先拆职责再继续堆逻辑

对于 AI/LLM 相关模块，额外要求：

- 文本对话默认通过 `LlmService` 接入 LangChain，不要重新引入新的 AI 框架并行维护
- 语音转写、图片生成等 OpenAI 原子能力继续集中在 `AiService`
- 会话历史以数据库消息记录为事实来源，不依赖框架自带 memory 作为主存储
- 模型选择、生成参数和运行时参数要分层表示，不允许混成一个模糊对象四处透传
- 请求级模型配置如果会影响可恢复任务，必须在创建任务时持久化，保证重连和恢复使用同一份配置
- 新增或重构 AI 模块时，应优先复用现有 SSE 任务机制，而不是为流式输出再造一套并行链路
- 构建 agent 的动作应尽量集中在同一编排层，包括构建上下文、系统提示词、模型参数、工具注入和消息组装
- Controller 不应直接拼 prompt、构建 LangChain message 或注入工具；普通业务 Service 也不应散落 agent 构建细节

### 5. Prompt 管理

系统提示词、agent prompt 和可复用提示词片段应优先放在 `src/prompts/` 目录，并通过统一入口导出。

不要在 service、controller 或 runner 中散落大段 prompt 字符串。短文本常量可以就近定义，但只要会影响 agent 行为或需要产品/运营反复调整，就应沉淀到 prompts 目录。

修改 prompt 时，应同时关注：

- 是否影响已有会话行为
- 是否需要更新对应 agent 的说明
- 是否需要调整测试或调试样例
- 是否会泄露内部实现、工具名称或敏感配置

### 6. 异常处理

优先抛出明确的 Nest 异常：

- `BadRequestException`
- `UnauthorizedException`
- `ForbiddenException`
- `NotFoundException`

不要返回“伪成功”数据来掩盖错误。

## 接口规范

### 1. 普通 HTTP 接口

普通 HTTP 接口走统一响应包装。

当前约定返回结构：

```json
{
  "code": 200,
  "data": {},
  "message": "success"
}
```

因此新增普通接口时，Controller 返回业务数据即可，不要手动再包一层相同结构。

### 2. SSE 接口

SSE 接口不走统一响应包装，使用 `text/event-stream`。

新增 SSE 能力时：

- 优先复用现有 `src/common/sse/`
- 不要自行手写另一套 SSE 输出协议
- 事件格式必须稳定，避免前端解析规则漂移

新增或修改 SSE 事件类型、payload 字段、任务状态枚举时，必须同步检查：

- 后端事件 DTO
- Swagger/OpenAPI 文档
- 前端 SSE 解析逻辑
- 前端 Orval 生成类型
- 联调说明或 AGENT 文档

## SSE 任务规范

当前仓库已经采用“任务化 SSE”方案，设计文档见 `docs/sse-task-architecture.md`。

### 1. 一次流式生成 = 一个任务

任何可恢复的长流式任务都应有稳定 `taskId`，而不是只依赖一次 HTTP 请求上下文。

### 2. 任务状态必须可追踪

涉及 SSE 任务时，应优先通过 `SseTask` 记录：

- 任务类型
- 当前状态
- 所属用户
- 所属会话
- 对应消息
- 最后事件游标
- 当前累计内容
- 错误信息
- 过期时间

### 3. 浏览器和微信小程序要同时兼容

设计 SSE 接口时必须同时考虑：

- 浏览器 `GET /stream`
- 微信小程序或通用客户端 `POST /resume`

恢复游标应允许从以下来源读取：

- body `lastEventId`
- query `cursor`
- header `Last-Event-ID`

### 4. 不要重复落库或重复执行

恢复 SSE 时，语义必须是“恢复已有任务”，不是“重新创建一次消息并重新跑一遍”。

禁止出现以下行为：

- 重连时重新创建 user message
- 重连时重新创建 assistant message
- 仅因为断线就重复启动同一个任务

### 5. 任务状态机必须闭环

如果新增或修改 `SseTaskStatus`，必须同步检查：

- 创建时写入什么状态
- 开始执行时写入什么状态
- 断连时如何处理
- 完成/失败/取消/过期时如何处理

不要只在 schema 里定义状态而不落实现。

## 数据库规范

### 1. 所有 schema 变更必须有 migration

修改 `prisma/schema.prisma` 后：

- 必须生成 migration
- migration 文件必须提交到仓库

除非是临时本地实验，否则不要只改 schema 不加 migration。

### 2. 不直接破坏历史数据

涉及字段重命名、枚举调整、表拆分时：

- 先评估兼容性
- 必要时写数据迁移逻辑
- 不要默认可以直接清库

### 3. 模型命名

Prisma 模型和字段命名应优先保持业务语义一致，不为短而短。

数据库映射名使用 `@map` / `@@map` 时，应保持现有风格一致。

## 第三方能力接入规范

### 1. OpenAI / LangChain

涉及模型、语音、图片、流式输出的改动时：

- 文本聊天优先复用 `LlmService`
- 语音和图片优先复用 `AiService`
- 不要在多个业务模块里直接散落 OpenAI 客户端实例
- 不要重新引入 Mastra 或其他并行 AI 框架让同一条链路同时维护两套抽象

### 2. 短信

短信服务当前还未接真实供应商。

若接入阿里云/腾讯云等：

- 在 `SmsService` 内统一封装
- 不要把供应商 SDK 调用散到 `AuthService`
- 需要考虑重试、限流、失败日志和开发环境降级行为

## 测试规范

### 1. 修改行为就应补测试

以下变更原则上应补测试：

- 新接口
- 接口返回结构变化
- 鉴权逻辑变化
- SSE 任务状态流转变化
- 数据库写入路径变化

### 2. 当前测试状态

目前仓库测试覆盖明显不足，后续补测试优先级应高于继续堆新功能。

优先补：

- auth e2e
- conversation e2e
- chat task create e2e
- sse-task status/resume/cancel e2e

## 提交前检查

在完成代码修改后，至少执行与本次改动相关的检查。

常用命令：

```bash
pnpm lint
pnpm build
pnpm test
pnpm test:e2e
pnpm db:generate
```

涉及 Prisma schema 变更时，额外检查：

```bash
pnpm db:generate
pnpm db:migrate:create
```

如果没有运行某项检查，说明里应明确写出原因。

## 联调注意事项

### 1. 认证接口

需要区分：

- access token
- refresh token
- token blacklist

不要把 refresh 逻辑和 access token 使用场景混淆。

### 2. SSE 联调

联调 SSE 时，应明确区分：

- 创建任务接口
- 建立流接口
- 恢复流接口
- 查询任务状态接口
- 取消任务接口

不要把“创建任务”和“开始消费流”混成一个前端动作假设。

### 3. 前后端协议变更

如果修改以下任何内容，必须同步更新文档或联调说明：

- 接口路径
- DTO 字段
- SSE 事件名
- SSE 数据体结构
- 任务状态枚举

### 4. 日志与敏感信息

LLM 调用、SSE 任务、第三方 API 调用和认证流程应保留必要日志，方便定位问题。

但日志中不要记录以下敏感信息：

- access token / refresh token
- 手机号验证码
- 用户隐私字段
- 完整用户输入和完整 prompt
- OpenAI、短信供应商等第三方密钥

需要排查 prompt 或模型输入时，优先记录脱敏摘要、长度、任务 ID、会话 ID 和错误码。

## 暂不建议做的事

在没有明确需求和验证前，不建议直接做以下行为：

- 随意引入新的基础设施层
- 并行保留两套 SSE 协议
- 在多个 service 中重复实现 Redis buffer 逻辑
- 为了“更优雅”而大范围重写已可工作的认证和会话逻辑

## 当前已知事实

以下内容是当前仓库现状，开发时应默认遵守：

- 全局开启 `ValidationPipe`
- 全局启用 CORS
- Swagger 路径是 `/api-docs`
- 默认存在统一响应拦截器
- SSE 接口显式跳过统一响应包裹
- 项目当前更接近“单进程可恢复 SSE”，不是多实例完全恢复架构

## 更新本文件的原则

当以下情况出现时，应优先更新本文件：

- 新增一类核心架构约束
- 引入新的通用开发流程
- 修改了 SSE / 数据库 / 接口的核心协作方式
- 发现团队反复踩同一个坑

这份文件应保持“短而有效”，避免写成大而空的流程文件。
