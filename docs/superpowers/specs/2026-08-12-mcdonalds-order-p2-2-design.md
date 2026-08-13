# P2-2 麦当劳订单持久化、回显与官方支付跳转设计

**日期：** 2026-08-12
**状态：** 已确认，待实施
**范围：** 麦当劳 MCP 下单成功后的订单入库、聊天/订单页回显、手动状态刷新与官方支付 URL 跳转。
**不包含：** 微信支付直连、自动轮询、用户删除订单、用户级 MCP 授权凭据、多商家通用订单域。

## 目标

用户通过聊天完成麦当劳下单后，系统应保存独立的订单业务事实。聊天历史显示一张稳定的订单卡，创建时可核对餐品与金额，后续可手动刷新履约状态。用户还能从「我的 > 我的订单」查看本系统创建的所有订单。

订单支付仍由麦当劳官方完成：MCP 返回的 `payH5Url` 不走微信支付，也不得出现在模型上下文、SSE、conversation trace、普通订单详情或前端持久化状态中。H5 打开官方 URL；微信小程序展示本地生成的二维码并允许复制链接。

## 已确认事实与约束

- `McpClientManager` 是 MCP client、tools/list 缓存、审核白名单和健康快照的唯一所有者；它不承担订单业务持久化。
- 已审核工具中，`create-order` 是唯一需 HITL 审批的工具，`query-order` 为只读工具。
- 当前全局麦当劳 token 只允许绑定的 `MCDONALDS_MCP_OWNER_USER_ID` 使用。订单模块继续以 `userId` 做所有查询和写入的强制归属过滤。
- MCP `tools/list` 对 `create-order` 和 `query-order` 只声明了输入 schema，未声明结果 schema。不得假设固定响应字段；必须保留安全原始快照，并只提升能可靠识别的字段。
- `conversation_trace` 记录策略选择、实际 MCP 工具调用和审批审计，不是订单业务事实。订单模块不从 trace/SSE 摘要反解析订单。
- `StreamTask` 的执行期已有 AsyncLocalStorage，提供 `taskId`、`userId`。工具包装可借此取得下单归属，不需要把任务信息塞入 MCP 工具参数。
- MCP 的 `create-order` 输入至少包括 `storeCode`、`orderType`、`beType`，并按到店/外送场景携带餐品、地址、取餐等字段。

## 架构

### 模块边界

新增 `apps/api/src/modules/mcdonalds-order/`，由 `McDonaldsOrderModule` 对外提供 `McDonaldsOrderService`。

`McDonaldsOrderService` 的职责：

1. 将 `McpClientManager` 提供的两个原始审核工具包装为可注入 Agent 的工具。
2. 在 `create-order` 成功后，读取当前任务执行上下文，解析、脱敏和持久化订单。
3. 提供订单列表、详情、手动刷新、支付链接和二维码查询。
4. 所有读取、刷新与支付链接操作都先按 `userId + orderId` 校验归属。

`McpClientManager` 的职责保持不变：初始化、缓存、白名单、来源元数据与健康快照。它不依赖订单模块。

`CapabilityRegistry` 注册到 `mcd-order` 的仍是审核后的八个 MCP 工具，但 `create-order`、`query-order` 改为由订单服务提供的薄包装工具；其运行时工具名、schema、描述和 MCP 来源元数据保持不变，确保路由、HITL、trace 和恢复快照不漂移。

### 调用流

```txt
Agent 选择 mcd-order
  -> CapabilityResolver 装配受控 create-order 包装工具
  -> HITL 审批通过
  -> McDonaldsOrderService 调原始 create-order
  -> 解析成功响应，剥离 payH5Url
  -> 使用 ALS 的 taskId/userId 写 McDonaldsOrder
  -> 向任务级订单上下文登记安全订单卡片 ID
  -> 工具仅向模型返回安全摘要，不含支付 URL
  -> StreamTask 写既有 tool.call.done / trace
  -> StreamTask 消费任务级订单上下文，额外发布安全 order.created 事件

用户点击刷新
  -> POST /mcdonalds-orders/:id/refresh
  -> 校验订单归属与 MCP token 所有者
  -> McDonaldsOrderService 直调审核后的 query-order
  -> 更新状态、履约安全快照与 lastRefreshedAt
  -> 追加订单刷新审计
  -> 返回安全订单详情
```

手动刷新不经过 Agent、LLM 或 HITL，因为它是对该用户已创建订单的确定性只读查询。它没有关联的对话任务，故不写 `conversation_trace`；订单模块在 `McDonaldsOrderRefresh` 中记录调用时间、成功/失败、更新后的状态和安全快照，作为订单域审计。聊天 Agent 发起的 `query-order` 仍按既有机制写 `conversation_trace`。

## 数据模型

新增 Prisma 模型 `McDonaldsOrder`，不抽象成通用 `ExternalOrder`，原因是当前只有一个供应商且结果 schema 尚未稳定。

### 关联与幂等

- `id`：本地订单 ID。
- `userId`：订单属主，所有 API 查询条件必带此值。
- `conversationId`、`messageId`、`taskId`：关联创建订单的聊天上下文；订单列表可不依赖会话历史存在。
- `externalOrderId`：MCP 返回的官方订单号；与 `userId` 联合唯一。以此 upsert，覆盖任务恢复或流事件重放造成的重复持久化。
- `createdAt`、`updatedAt`：本地记录生命周期。
- 删除会话时订单不级联删除；聊天历史可消失，但用户订单长期保留。

### 规范化展示字段

只在响应中稳定可识别时写入，缺失时为 `null`：

- `status`、`statusLabel`、`statusUpdatedAt`：官方订单/履约状态。
- `storeCode`、`storeName`：门店标识与展示名。
- `orderType`、`fulfillmentType`：到店/外送及履约方式。
- `totalAmount`、`discountAmount`、`currency`：金额快照。
- `estimatedDeliveryAt` / `estimatedReadyAt`：可用时保存预计时间。
- `items`：可回显的餐品 JSON 快照，包括名称、数量、规格/特制、单价/小计和图片（若 MCP 提供）。
- `lastRefreshedAt`：最近一次成功向官方查询订单状态的时间。

新增 `McDonaldsOrderRefresh` 作为订单状态查询审计：关联订单，记录请求时间、完成时间、成功/失败、更新后状态、错误摘要和清洗后的查询响应。它不保存支付 URL，也不承担聊天 trace 职责。

### 原始快照与支付会话

- `rawSnapshot`：已清洗的 MCP 成功响应 JSON。递归剥离 `payH5Url`、大小写变体和明确标记为支付跳转的 URL 字段；绝不把未清洗原响应用作前端 DTO。
- `paymentUrlCiphertext`：`payH5Url` 使用 `MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY` 进行 AEAD 加密后保存；密钥缺失时 API 启动失败。
- `paymentUrlExpiresAt`：创建订单成功后默认 30 分钟。MCP 若返回明确有效期则取更早的时间。
- 不保存二维码图片。二维码由支付接口即时编码 URL 成 PNG，响应不持久化也不写日志。

支付 URL 只允许在「订单属于当前用户 + 订单状态仍待支付 + 未过期」时读取。其它情况返回明确业务错误（非 404 伪装成功）。

## API

所有端点使用 JWT 鉴权与统一 HTTP 响应包装。

| 方法与路径                                | 行为                                         | 返回                                      |
| ----------------------------------------- | -------------------------------------------- | ----------------------------------------- |
| `GET /mcdonalds-orders?cursor=&limit=`    | 当前用户的订单列表，按创建时间倒序、游标分页 | 安全订单摘要数组、`nextCursor`、`hasMore` |
| `GET /mcdonalds-orders/:id`               | 获取当前用户一条订单详情                     | 完整安全订单 DTO、餐品快照、最新同步时间  |
| `POST /mcdonalds-orders/:id/refresh`      | 直接调用 `query-order` 并更新本地状态        | 更新后的安全订单 DTO                      |
| `POST /mcdonalds-orders/:id/payment-link` | 读取短期官方支付链接                         | `{ url, expiresAt }`，仅 H5 消费          |
| `GET /mcdonalds-orders/:id/payment-qr`    | 为短期官方支付链接即时编码 PNG               | `image/png`，禁止缓存                     |

列表/详情/刷新 DTO 均不含 `paymentUrl`。支付链接接口本身也不写入普通日志或 conversation trace。

## 流式与历史回显契约

新增 `StreamTaskEventType.OrderCreated = 'order.created'` 及共享 `OrderCreatedPayload`。它只含本地订单 ID 与安全的订单卡片摘要：状态、门店、履约方式、金额、餐品列表、时间戳，不含外部支付 URL、密文或原始响应。

下单成功后，`McDonaldsOrderService` 完成持久化并给出安全订单结果。`StreamTaskService` 在同一任务的 `create-order` 成功事件后发布 `order.created`，前端立即把卡片挂到该 assistant `messageId`。不以模型文本是否提到订单为准。

具体传递方式是任务级 AsyncLocalStorage 订单上下文：`create-order` 包装器写入已持久化的本地订单 ID；`StreamTaskService` 在处理该轮工具完成事件时消费该上下文并读取安全卡片 DTO。该上下文与现有 taskId/userId 上下文同生命周期、跨 await 隔离，避免从 ToolMessage 文本、SSE payload 或 trace 摘要反解析订单业务数据。

会话历史加载时，`ConversationService.findAllByUser()` 按 assistant `messageId` 关联订单记录，并在 `ConversationMessageDto` 增加可选 `orders: McDonaldsOrderCardDto[]`。这让刷新页面后仍能回显相同卡片，且卡片只消费订单表事实。

## 前端

### 聊天订单卡

一张稳定卡片同时展示：

- 顶部：麦当劳标识、门店、当前履约状态、预计时间和短状态进度条。
- 中部：餐品名称、数量、规格/特制、优惠和实付金额。
- 底部：进入订单详情；待支付显示官方支付入口，其它状态显示“刷新订单状态”。

创建成功时完整显示餐品和金额；刷新只更新顶部状态区、预计时间和同步时间，不产生新消息或重复卡片。未知状态显示中性原文状态，不能推断为已支付或已完成。

### 历史订单

在「我的」页面的“账户服务”区增加标准列表行「我的订单」，不做供应商品牌主视觉。进入独立订单列表页，按创建时间倒序展示本系统创建的订单；进入详情页复用聊天卡信息并提供手动刷新。

订单长期保留，初版不提供删除入口。

### 官方支付

- H5：点击“去官方支付”后请求支付链接接口并打开官方 URL。
- 微信小程序：点击后请求二维码接口，在支付弹层展示二维码；同时提供“保存二维码”和“复制支付链接”。二维码由后端即时生成，不走第三方服务、不产生存储费用。
- 支付按钮只在待支付状态出现。支付页面打开不代表支付成功；用户须返回后手动刷新订单状态。

## 错误处理与安全

- `create-order` 成功但无法可靠识别官方订单号时：保留 MCP 工具审计，向模型返回明确的安全失败说明；不创建伪订单卡、不写不具幂等键的订单记录。
- `query-order` 或刷新失败时：保留上次有效订单快照，接口返回错误；前端显示刷新失败与上次同步时间，不把失败当作“无订单”。
- 支付链接过期：返回明确的“支付链接已过期，请刷新订单状态或在官方渠道继续支付”错误，绝不生成空二维码。
- 支付 URL 必须在模型、SSE、trace、`rawSnapshot`、普通 DTO 和前端 store 前被剥离；禁止错误日志记录 URL 或请求头。
- 所有订单和支付端点都先按 `id + userId` 读取；不因订单不存在或非本人而暴露外部订单号和支付状态。
- 全局 MCP token 使用阶段，刷新和支付读取也要复用 `isMcDonaldsTokenOwner(userId)` 检查；多用户 MCP 授权落地前，其他用户无权查看或查询该 token 下的订单。

## 测试与验证

### 单元测试

- 响应解析：常见嵌套结构、缺失字段、未知状态、支付 URL 剥离、金额与餐品读取。
- 加密：加密/解密、过期、错误密钥、URL 不进入安全 DTO 或快照。
- 下单包装：具备 ALS 上下文时按 `(userId, externalOrderId)` 幂等 upsert；没有上下文或无订单号不写订单。
- 刷新：只对属主调用 query-order；失败不覆盖旧快照；更新履约字段、同步时间与订单刷新审计。
- Controller：归属校验、支付链接状态/有效期限制、二维码响应类型与禁止缓存。
- 流式与历史：`order.created` 只含安全字段；会话消息按 `messageId` 附带订单卡。

### 构建与人工验证

- `pnpm --filter ./apps/api run build`
- 订单模块与 Agent/MCP 相关 Jest 测试（禁用 Watchman）。
- `pnpm --filter ./apps/mobile run typecheck`
- `pnpm --filter ./apps/mobile run build:weapp`
- 更新 OpenAPI 后在 `apps/mobile/` 运行 `pnpm generate:api:local`，再检查生成 client 与页面类型。
- 真机验证需要用户在真实麦当劳账号下主动完成一次下单和官方支付；Agent 不为探测 schema 创建真实订单。

## 实施顺序

1. Prisma schema 与订单模块服务、响应解析和支付 URL 加密。
2. `McpClientManager` 工具包装接线与 `CapabilityRegistry` 替换 create/query 两个工具。
3. 订单 REST 接口、DTO、OpenAPI 与 `order.created`/会话历史关联。
4. 生成前端 client，增加订单卡、支付弹层、订单列表/详情页和“我的订单”入口。
5. 单元测试、API build、mobile typecheck/build 与真实环境人工验证说明。
