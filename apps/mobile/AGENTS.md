# FRONTEND_AGENTS.md

## 目的

本文件用于约束与 `Litter-Bear-Server` 对接的前端开发规范。

目标：

- 保持前后端协议理解一致
- 降低浏览器和微信小程序联调成本
- 避免因为 SSE、鉴权、统一响应格式理解不一致而反复返工

这份文件面向：

- H5前端
- 微信小程序前端
- 负责联调的客户端开发者

## 当前后端事实

当前后端是 NestJS 服务，接口文档地址：

- `/api-docs`

全局约束：

- 普通 HTTP 接口返回统一结构
- SSE 接口不走统一包裹
- 认证使用 JWT Bearer Token
- 聊天已经改成“先创建任务，再消费 SSE”

## 前端开发原则

### 1. 先按协议实现，不靠猜

所有接口字段、SSE 事件名、返回结构，都应以 Swagger 和后端文档为准。

不要根据旧版本接口习惯自行脑补：

- 聊天接口现在不是直接返回流
- 创建任务接口和消费流接口已经拆开
- 浏览器和微信小程序的 SSE 方式不完全相同

### 2. 前端状态要围绕任务而不是请求

对于聊天流式生成，前端应围绕 `taskId` 管理状态，而不是围绕一次 `fetch` 请求管理状态。

推荐状态主键：

- `conversationId`
- `messageId`
- `taskId`

### 3. 所有异常都要可见

不要把请求失败、SSE 断流、token 失效、任务过期静默吞掉。

至少要做到：

- 控制台有日志
- UI 有错误态
- 可以触发重试或重新发起任务

## HTTP 接口约定

### 1. 普通接口统一返回格式

普通 HTTP 接口统一返回：

```json
{
  "code": 200,
  "data": {},
  "message": "success"
}
```

因此前端请求封装层需要统一解包 `data`，不要每个页面手写一套解析逻辑。

推荐封装：

- 成功时返回 `response.data.data`
- 非 200/非预期结构时统一抛错

### 2. SSE 接口不是这个结构

SSE 接口返回 `text/event-stream`，不走上面的 `code/data/message` 包裹。

不要把 SSE 响应当普通 JSON 请求处理。

## 鉴权规范

### 1. Token 使用

当前涉及：

- `token`：access token
- `refreshToken`：refresh token

前端应明确区分，不要混用。

### 2. 受保护接口

除登录、发验证码、刷新 token、健康检查外，大部分业务接口都需要带：

```http
Authorization: Bearer <token>
```

### 3. 刷新策略

推荐策略：

1. 请求遇到 401
2. 尝试调用 `/auth/refresh`
3. 刷新成功后重放原请求
4. 刷新失败则清理登录态并跳登录页

不要在多个页面各自实现一套刷新逻辑。

## 模块联调规范

### 1. 认证

当前认证接口：

- `POST /auth/wechat-login`
- `POST /auth/phone/send-code`
- `POST /auth/phone/login`
- `POST /auth/refresh`
- `POST /auth/logout`

前端约束：

- 登录成功后统一保存 `token` 和 `refreshToken`
- 登出时主动调用 `/auth/logout`
- 不要只删本地 token 而不通知服务端

### 2. 用户

当前接口：

- `GET /user/profile`
- `PATCH /user/profile`

前端约束：

- 编辑资料页提交字段应只传用户真正修改的内容
- 不要传空字符串去覆盖未编辑字段，除非产品就是这么定义的

### 3. 会话

当前接口：

- `GET /conversations`
- `POST /conversations`
- `DELETE /conversations/:id`

当前 `GET /conversations` 会返回会话及消息列表。

前端约束：

- 列表页应以 `updatedAt` 排序展示
- 删除会话后要同步清理本地会话状态和当前选中状态
- 会话页进入时优先读接口返回，不要假设本地缓存一定可信

### 4. 图片生成

当前接口：

- `POST /chat/image-generations`

前端约束：

- 这不是 SSE 接口
- 结果应视为普通消息结果处理
- 成功后应把生成出的图片消息同步到当前会话 UI

## SSE 联调规范

这是当前最重要的前端约束。

### 1. 聊天流程不是“一次请求直接出流”

当前正确流程：

1. `POST /chat/completions`
2. 后端返回 `taskId`、`messageId`、`status`
3. 前端再根据运行环境连接 SSE
4. 收到流式事件后更新 UI

语音任务流程类似：

1. `POST /chat/voice-completions`
2. 拿到 `taskId`
3. 再连接或恢复 SSE

### 2. H5 和浏览器接法

H5 和浏览器端优先使用项目请求封装消费 chunk 流，恢复已有任务时使用：

- `POST /stream-tasks/:taskId/resume`

浏览器原生 `EventSource` 兼容入口为：

- `GET /stream-tasks/:taskId/stream`

该入口只用于确实需要原生 `EventSource` 的场景，不是 H5 必须使用的专属接口。

恢复游标可以依赖：

- `Last-Event-ID`
- 或 query `cursor`
- 或 body `lastEventId`

如果浏览器端使用 `EventSource`，要注意：

- 原生 `EventSource` 对 header 控制有限
- 若需要更强控制，可自己用流式请求方案

### 3. 微信小程序接法

微信小程序优先使用：

- `POST /stream-tasks/:taskId/resume`

body 示例：

```json
{
  "lastEventId": 12
}
```

前端职责：

- 自己解析 SSE chunk
- 自己保存 `lastEventId`
- 断线后按指数退避重连

### 4. 任务查询接口

当前接口：

- `GET /stream-tasks/:taskId`

前端用途：

- 页面重进时查询任务状态
- App 恢复前台时确认任务是否还可恢复
- 判断当前任务是继续连流，还是直接渲染最终结果

### 5. 取消任务

当前接口：

- `POST /stream-tasks/:taskId/cancel`

前端约束：

- 用户点击“停止生成”后应调用该接口
- 本地 UI 要同步切到“已停止”或“已取消”状态
- 不要只关闭前端连接，不通知后端

## SSE 事件处理规范

当前后端设计中的事件类型包括：

- `task.started`
- `message.delta`
- `message.done`
- `task.completed`
- `task.error`
- `task.expired`
- `task.canceled`

前端处理建议：

- `task.started`：标记任务进入流式状态
- `message.delta`：追加增量文本
- `message.done`：写入最终文本并关闭“生成中”状态
- `task.completed`：任务完成，收尾
- `task.error`：展示错误态
- `task.expired`：提示用户重新发起任务
- `task.canceled`：标记为已取消

### 重要约束

不要只依赖一个事件名判断一切。

前端状态应同时考虑：

- 当前任务状态
- 当前消息是否已完成
- 当前连接是否关闭

## 前端本地状态建议

建议至少维护以下状态：

- `accessToken`
- `refreshToken`
- `currentConversationId`
- `messagesByConversation`
- `taskByMessageId`
- `lastEventIdByTaskId`
- `connectionStateByTaskId`

对流式消息，推荐消息状态至少区分：

- `pending`
- `streaming`
- `done`
- `error`
- `canceled`

## 跨端兼容规范

本项目需要同时兼容 H5 和微信小程序。新增页面、组件或样式时，应优先使用 Taro 和项目现有跨端封装。

### 1. 平台能力边界

不要在业务组件中直接依赖 H5 only 能力：

- `window`
- `document`
- DOM 查询和手动操作
- 浏览器专属存储、事件或样式能力

确实需要使用时，必须通过环境判断或跨端适配层隔离，不要让小程序构建产物引用到 H5 only 代码。

### 2. 单位与安全区

涉及 UI 尺寸时，应优先使用项目既有 Tailwind/rem 写法，由构建链路负责小程序端转换。

以下能力应走公共方案，不要在页面里各自硬编码：

- 顶部安全区
- 微信小程序右上角胶囊避让
- tabbar 页面顶部留白
- 页面容器最小高度

如果必须写固定尺寸，需要同时确认 H5 和微信小程序端的显示效果。

### 3. UI 双端验证

涉及布局、尺寸、导航栏、安全区、tabbar、长文本或图片展示的改动，至少验证：

- H5 页面没有错位、遮挡、横向滚动
- 微信小程序页面没有被胶囊、状态栏、tabbar 遮挡
- 关键文本在小屏幕下不会溢出容器

涉及 `frontend/UI/h5/` 原型截图中的问题时，应把对应图片作为回归参照。

## UI 交互建议

### 1. 聊天发送

发送消息后不要等 SSE 回来再插入 assistant 占位。

建议：

- 先插入 user message
- 插入 assistant 占位消息
- 创建任务
- 绑定 `taskId` 到该 assistant message
- 随流式事件更新内容

### 2. 页面重进恢复

若页面重进时存在未结束任务：

1. 查任务状态
2. 若仍可恢复，则继续连流
3. 若已完成，则直接展示最终内容
4. 若已过期/失败，则展示错误态

### 3. 弱网和断线

前端应假设移动端弱网是常态。

至少做到：

- 连接异常时不立即丢弃任务
- 保存 `lastEventId`
- 自动重试
- 重试失败后给出手动恢复入口

## UI 组件封装规范

跨页面重复出现的能力应优先封装为公共组件或 hook，不要在页面里散写。

优先封装：

- 通用头部栏
- 安全区容器
- tabbar 页面容器
- 空状态、错误态、加载态
- 请求状态和重试入口
- 流式任务连接与恢复逻辑

公共组件应保持 props 语义清晰，不要为了兼容未来假想场景提前塞入大量可选参数。

## 微信小程序特别说明

微信小程序端不要默认浏览器那套 SSE 能力完全可用。

实现时优先考虑：

- `POST /stream-tasks/:taskId/resume`
- 请求体带 `lastEventId`
- 自己做 chunk 解析
- 自己管理重连

不要把浏览器 `EventSource` 逻辑原样照搬到小程序。

## Tailwind 与小程序 WXSS 兼容注意事项

本项目同时维护 H5 和微信小程序端，CSS 方案基于 Tailwind CSS + `weapp-tailwindcss/vite`。改 UI 或调整构建配置时，要特别注意 Tailwind 的扫描范围和单位转换。

### 1. 不要让原型代码进入业务 Tailwind 扫描

`frontend/UI/` 目录用于存放图片、Figma 下载原型代码和参考素材，不是小程序业务源码。

业务入口 `src/app.css` 必须显式限制 Tailwind 扫描范围：

```css
@import "weapp-tailwindcss/utilities.css" layer(utilities) source(none);
@source "./**/*.{html,js,ts,jsx,tsx}";
```

不要随意去掉 `source(none)`，也不要把 `frontend/UI/**`、`proto-code/**` 加进业务 Tailwind content/source。原型代码中常见的 shadcn/Radix/CSS4 写法会生成小程序不支持的 WXSS。

### 2. WXSS 报 token `view` 时优先查非法选择器

如果微信开发者工具报类似错误：

```text
[ WXSS 文件编译错误]
./app-origin.wxss(...): error at token `view`
```

优先检查 `dist/weapp/app-origin.wxss` 是否混入了这些选择器或类名：

- `:has(`
- `cmdk`
- `data-sidebar`
- `group-has`
- `peer-data`

可用命令：

```bash
rg -n ":has\(|cmdk|data-sidebar|group-has|peer-data" dist/weapp/app-origin.wxss
```

如果能搜到，通常说明 Tailwind 又扫到了 `frontend/UI/proto-code` 一类的原型目录，需要先修正扫描范围，而不是在生成后的 WXSS 里手工删规则。

### 3. 单位转换保持跨端一致

当前 `weapp-tailwindcss/vite` 的 `rem2rpx` 只应在非 H5 环境开启；H5 端保持 rem，微信小程序端转换为 rpx。改动 `config/index.ts` 时不要简单改成全端统一转换，否则容易再次出现 H5 尺寸异常或小程序 UI 缩放错位。

涉及 UI 尺寸的新增样式优先使用项目现有的 rem/Tailwind 写法，由构建链路负责在小程序端转为 rpx。

### 4. H5 端不要把 Tailwind 工具类放进 CSS layer

Taro React 编译到 H5 时，`View` 等组件会生成带默认样式的自定义标签。Tailwind CSS 4 如果通过 `@import "...css" layer(...)`、`@layer base` 或 `@layer utilities` 输出工具类，H5 端可能出现 Tailwind 工具类优先级低于 Taro 默认样式的问题，典型表现是 `flex`、`grid`、间距等类名看起来没有生效。

`src/app.css` 中 Tailwind 入口应避免使用 layer 包裹，例如保持：

```css
@import "weapp-tailwindcss/theme.css";
@import "weapp-tailwindcss/utilities.css";
```

不要改回：

```css
@import "weapp-tailwindcss/theme.css" layer(theme);
@import "weapp-tailwindcss/utilities.css" layer(utilities) source(none);
@layer base { ... }
```

这个问题可参考 `weapp-tailwindcss` 的 issue #630。若 H5 再次出现 `View` 默认 `display: block` 覆盖 Tailwind `flex` 的现象，优先检查 `src/app.css` 是否重新引入了 `layer`。

### 5. 改完 CSS 构建配置必须双端验证

涉及 `src/app.css`、`tailwind.config.js`、`config/index.ts`、`weapp-tailwindcss` 配置的改动，至少执行：

```bash
pnpm build:weapp
pnpm build:h5
pnpm typecheck
```

小程序构建通过后，还要确认生成的 `app-origin.wxss` 中没有上面列出的非法选择器。

## API 生成产物规范

当前前端 API 由 Orval 根据后端 Swagger/OpenAPI 文档生成。

### 1. 不手改生成产物

`src/api/generated*` 相关文件原则上视为生成产物，不要直接手工修改。

`backend/docs/openapi.json` 也视为接口生成链路的快照产物，不要主动手工修改或单独编辑该文件。需要更新 OpenAPI 快照或前端 API 类型时，统一在 `frontend/` 目录执行：

```bash
pnpm generate:api:local
```

该命令会先调用后端脚本导出 OpenAPI，再通过 Orval 生成前端 API。

接口字段、返回结构或类型不符合预期时，应优先检查：

- 后端 DTO
- Swagger 装饰器
- `backend/docs/openapi.json`
- Orval 配置

确认后重新生成 API，而不是在生成文件里补丁式修改。

### 2. 接口变更要同步生成

后端接口发生以下变化时，前端应重新生成并检查 API 类型：

- 路径变化
- 入参 DTO 变化
- 返回 DTO 变化
- 枚举变化
- 文件上传或表单格式变化

生成后需要检查页面调用处是否出现类型变化，不要只看生成命令是否通过。

## 与后端协作的变更纪律

以下内容如果发生变更，前端实现必须同步检查：

- DTO 字段名
- 接口路径
- token 字段名
- SSE 事件名
- SSE `data` 内容结构
- 任务状态枚举

如果联调发现协议与实现不一致：

- 先确认代码真实行为
- 再更新文档
- 不要让“口头约定”长期替代代码和文档

## 当前已知限制

前端开发时应默认知道以下限制：

- 当前流式任务更接近“单进程可恢复”
- 服务重启后，已缓存事件可以补发，但未完成生成不保证真正续跑
- 语音流式任务链路虽然已有接口，但联调时应重点验证实际执行是否闭环
- 当前测试覆盖较弱，联调发现问题的概率较高

## 推荐前端封装

建议至少封装以下能力：

- `request()`：统一处理 `code/data/message`
- `authorizedRequest()`：自动带 token
- `refreshTokenIfNeeded()`：统一刷新逻辑
- `createChatTask()`：创建聊天任务
- `connectStreamTask()`：浏览器流式连接
- `resumeStreamTask()`：恢复流式任务连接
- `cancelStreamTask()`：取消流式任务

不要在页面组件里直接散写所有网络协议细节。

## 更新本文件的原则

当以下内容变化时，应优先更新本文件：

- 聊天链路改造
- SSE 协议变化
- 认证字段变化
- 会话和消息数据结构变化
- 浏览器/微信小程序接法发生变化

这份文件应优先服务联调效率，而不是追求面面俱到。
