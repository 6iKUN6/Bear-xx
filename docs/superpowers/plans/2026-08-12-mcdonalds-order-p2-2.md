# 麦当劳订单 P2-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将麦当劳 MCP 下单结果持久化为用户订单，提供订单历史、手动状态刷新与安全的官方支付跳转，并在聊天历史中稳定回显订单卡片。

**Architecture:** 新建 `mcdonalds-order` 业务模块，持有订单解析、支付 URL 加密、订单刷新与 REST API；`McpClientManager` 继续只管理连接和审核工具。Agent 接入时仅以薄包装替换 `create-order` 与 `query-order`，包装器从任务级 ALS 读取归属并登记安全订单卡；StreamTask 从同一上下文发出安全 `order.created` 事件，历史加载从订单表按 `messageId` 回填卡片。

**Tech Stack:** NestJS、Prisma/PostgreSQL、LangChain `DynamicStructuredTool`、Node `crypto` AES-256-GCM、`qrcode` PNG 编码、Taro/React、共享 `@litter-bear/types/protocol`。

---

## 文件结构

- `apps/api/prisma/schema.prisma`：订单、订单刷新审计模型和关联。
- `apps/api/src/modules/mcdonalds-order/`：订单解析、加密、任务上下文、服务、Controller、DTO、模块与单元测试。
- `apps/api/src/modules/ai/mcp/mcp-client-manager.service.ts`：按 MCP 原始工具名取得审核后的原始工具。
- `apps/api/src/modules/ai/agent-loop/capability/capability.registry.ts`：将 `create-order`/`query-order` 注册为订单服务包装工具。
- `apps/api/src/modules/stream-task/stream-task.service.ts`：在工具完成时消费任务订单上下文并发送 `order.created`。
- `apps/api/src/modules/conversation/*`：会话消息历史回填安全订单卡。
- `packages/types/src/protocol/{events,payloads}.ts`：`order.created` 的唯一线上契约。
- `apps/mobile/src/pages/orders/**`、`apps/mobile/src/components/McdonaldsOrderCard/**`：订单列表、详情、聊天卡与支付弹层。
- `apps/mobile/src/api/generated/**`：仅通过 Orval 更新，不手工编辑。

## Task 1: 订单数据模型与纯函数边界

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/src/modules/mcdonalds-order/mcdonalds-order.types.ts`
- Create: `apps/api/src/modules/mcdonalds-order/mcdonalds-order.parser.ts`
- Create: `apps/api/src/modules/mcdonalds-order/mcdonalds-order.parser.spec.ts`
- Create: `apps/api/src/modules/mcdonalds-order/payment-url-crypto.service.ts`
- Create: `apps/api/src/modules/mcdonalds-order/payment-url-crypto.service.spec.ts`
- Modify: `apps/api/src/config/env.validation.ts`
- Modify: `apps/api/.env.example`

- [ ] **Step 1: 写解析与加密的失败测试**

```ts
it("extracts a nested order id, strips payH5Url, and keeps a safe snapshot", () => {
  const result = parseMcDonaldsOrderResponse({
    data: {
      orderId: "external-1",
      payH5Url: "https://pay.example/session",
      status: "UNPAID",
    },
  });
  expect(result.externalOrderId).toBe("external-1");
  expect(result.paymentUrl).toBe("https://pay.example/session");
  expect(JSON.stringify(result.safeSnapshot)).not.toContain("pay.example");
});

it("round-trips an encrypted payment URL and rejects an expired value", () => {
  const crypto = new PaymentUrlCryptoService(configWith32ByteBase64Key);
  const encrypted = crypto.encrypt("https://pay.example/session");
  expect(crypto.decrypt(encrypted)).toBe("https://pay.example/session");
  expect(() => crypto.assertNotExpired(new Date(0))).toThrow("支付链接已过期");
});
```

- [ ] **Step 2: 运行解析和加密测试，确认失败原因是模块不存在**

Run: `pnpm --filter ./apps/api exec jest --runInBand --watchman=false src/modules/mcdonalds-order/mcdonalds-order.parser.spec.ts src/modules/mcdonalds-order/payment-url-crypto.service.spec.ts`
Expected: FAIL，提示测试目标尚不存在。

- [ ] **Step 3: 增加 Prisma 模型，只改 schema 不创建 migration SQL**

```prisma
model McDonaldsOrder {
  id                     String   @id @default(cuid())
  userId                 String   @map("user_id")
  conversationId         String?  @map("conversation_id")
  messageId              String?  @map("message_id")
  taskId                 String?  @map("task_id")
  externalOrderId        String   @map("external_order_id")
  status                 String?
  statusLabel            String?  @map("status_label")
  storeCode              String?  @map("store_code")
  storeName              String?  @map("store_name")
  orderType              Int?     @map("order_type")
  fulfillmentType        String?  @map("fulfillment_type")
  totalAmount            Decimal? @map("total_amount") @db.Decimal(12, 2)
  discountAmount         Decimal? @map("discount_amount") @db.Decimal(12, 2)
  currency               String?  @default("CNY")
  items                  Json?
  rawSnapshot            Json?    @map("raw_snapshot")
  paymentUrlCiphertext   String?  @map("payment_url_ciphertext") @db.Text
  paymentUrlExpiresAt    DateTime? @map("payment_url_expires_at")
  lastRefreshedAt        DateTime? @map("last_refreshed_at")
  createdAt              DateTime @default(now()) @map("created_at")
  updatedAt              DateTime @updatedAt @map("updated_at")
  @@unique([userId, externalOrderId])
  @@index([userId, createdAt])
  @@index([messageId])
  @@map("mcdonalds_orders")
}
```

再增加 `McDonaldsOrderRefresh`，包含 `orderId`、开始/结束时间、状态、错误摘要、清洗快照；它只审计订单页刷新，不关联 `conversation_trace`。

- [ ] **Step 4: 实现解析器与加密服务**

```ts
export function parseMcDonaldsOrderResponse(raw: unknown): ParsedMcDonaldsOrder {
  const normalized = parseToolOutput(raw);
  const paymentUrl = findPaymentUrl(normalized);
  const safeSnapshot = stripPaymentUrls(normalized);
  return {
    externalOrderId: findStringByKeys(safeSnapshot, ['orderId', 'orderNo', 'orderNumber']),
    paymentUrl,
    safeSnapshot,
    status: findStringByKeys(safeSnapshot, ['orderStatus', 'status']),
    items: findArrayByKeys(safeSnapshot, ['items', 'itemList', 'products']),
  };
}

encrypt(url: string): string // AES-256-GCM，随机 12-byte IV，输出 version.iv.tag.ciphertext 的 base64url 段
decrypt(ciphertext: string): string // 认证失败抛 BadRequestException，不返回部分明文
```

递归清洗器必须按大小写无关的 `payH5Url`、`paymentUrl`、`paymentLink` 和包含 `payment`+`url/link` 的键删除 URL，且不能修改原始对象。环境校验要求 `MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY` 为可解码的 32-byte base64 值。

- [ ] **Step 5: 运行测试与 API build**

Run: 同 Step 2 命令；`pnpm --filter ./apps/api run build`
Expected: 两组测试通过；Nest build 通过。

## Task 2: 订单服务、受控 MCP 包装与任务订单上下文

**Files:**

- Create: `apps/api/src/modules/mcdonalds-order/mcdonalds-order-context.ts`
- Create: `apps/api/src/modules/mcdonalds-order/mcdonalds-order.service.ts`
- Create: `apps/api/src/modules/mcdonalds-order/mcdonalds-order.service.spec.ts`
- Create: `apps/api/src/modules/mcdonalds-order/mcdonalds-order.module.ts`
- Modify: `apps/api/src/modules/ai/mcp/mcp-client-manager.service.ts`
- Modify: `apps/api/src/modules/ai/agent-loop/capability/capability.registry.ts`
- Modify: `apps/api/src/modules/ai/ai.module.ts`

- [ ] **Step 1: 写包装与幂等入库的失败测试**

```ts
it("wraps create-order, upserts by user and external order id, and returns no payment URL", async () => {
  await runWithMcDonaldsOrderContext("task-1", "user-1", async () => {
    const result = await service
      .wrapAgentTool(rawCreateTool, metadata)
      .invoke(validInput);
    expect(result).not.toContain("pay.example");
  });
  expect(prisma.mcDonaldsOrder.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        userId_externalOrderId: {
          userId: "user-1",
          externalOrderId: "external-1",
        },
      },
    }),
  );
});

it("does not create a local order when create-order has no parseable order id", async () => {
  await expect(
    invokeCreateWith({ data: { accepted: true } }),
  ).resolves.toContain("未识别");
  expect(prisma.mcDonaldsOrder.upsert).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行服务测试并确认失败**

Run: `pnpm --filter ./apps/api exec jest --runInBand --watchman=false src/modules/mcdonalds-order/mcdonalds-order.service.spec.ts`
Expected: FAIL，目标服务不存在。

- [ ] **Step 3: 实现任务订单上下文**

```ts
interface McDonaldsOrderContext {
  taskId: string;
  userId: string;
  orderIds: string[];
}
export function runWithMcDonaldsOrderContext<T>(
  taskId: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T>;
export function registerCreatedMcDonaldsOrder(orderId: string): void;
export function consumeCreatedMcDonaldsOrderIds(): string[];
```

在 `StreamTaskService.runChatTask()` 的既有 `runWithModelCallContext(task.id, ..., task.userId)` 外层或同一回调内包裹此上下文，使恢复任务和并发任务隔离。

- [ ] **Step 4: 实现订单服务与原始工具查找**

在 `McpClientManager` 新增 `getToolByMcpName(server, mcpTool)`，以已审核的 `metadataByRuntimeToolName` 查找，找不到即抛错；不重新请求 tools/list。

订单服务以 `new DynamicStructuredTool({ name, description, schema, func })` 包装原始工具：

```ts
private async invokeCreateOrder(input: Record<string, unknown>): Promise<string> {
  const raw = await rawTool.invoke(input);
  const parsed = parseMcDonaldsOrderResponse(raw);
  if (!parsed.externalOrderId) return '订单已提交，但未识别到官方订单号，请到麦当劳官方渠道核实。';
  const context = requireMcDonaldsOrderContext();
  const order = await this.prisma.mcDonaldsOrder.upsert({ /* userId + externalOrderId */ });
  registerCreatedMcDonaldsOrder(order.id);
  return formatSafeAgentOrderResult(order);
}
```

包装的 `name`、`description`、`schema` 必须与原始工具一致；`create-order` 仍由 registry 标记 `requiresApproval`。`query-order` 的 Agent 包装器仅返回清洗结果，不把直接用户刷新误记为 Agent trace。

- [ ] **Step 5: 在 CapabilityRegistry 接线**

```ts
const registeredTool =
  metadata.mcpTool === "create-order" || metadata.mcpTool === "query-order"
    ? this.mcdonaldsOrderService.wrapAgentTool(tool, metadata)
    : tool;
this.registerTool(registeredTool, [MCDONALDS_ORDER_TOOL_GROUP], {
  requiresApproval: metadata.mcpTool === "create-order",
  metadata,
});
```

`AiModule` 只导入 `McDonaldsOrderModule`，不得让 `McpClientManager` 反向依赖订单模块。

- [ ] **Step 6: 运行服务、registry、MCP 测试与 build**

Run: `pnpm --filter ./apps/api exec jest --runInBand --watchman=false src/modules/mcdonalds-order/mcdonalds-order.service.spec.ts src/modules/ai/mcp/mcp-client-manager.service.spec.ts src/modules/ai/agent-loop/capability/capability.registry.spec.ts`
Run: `pnpm --filter ./apps/api run build`
Expected: 相关测试和 build 通过。

## Task 3: 订单 REST API、刷新审计、支付链接与二维码

**Files:**

- Create: `apps/api/src/modules/mcdonalds-order/mcdonalds-order.controller.ts`
- Create: `apps/api/src/modules/mcdonalds-order/dto/mcdonalds-order-query.dto.ts`
- Create: `apps/api/src/modules/mcdonalds-order/dto/mcdonalds-order-response.dto.ts`
- Create: `apps/api/src/modules/mcdonalds-order/mcdonalds-order.controller.spec.ts`
- Modify: `apps/api/src/modules/mcdonalds-order/mcdonalds-order.service.ts`
- Modify: `apps/api/src/modules/mcdonalds-order/mcdonalds-order.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/package.json`
- Modify: workspace lockfile

- [ ] **Step 1: 添加二维码本地编码依赖**

Run: `pnpm --filter ./apps/api add qrcode`
Expected: `apps/api/package.json` 和 workspace `pnpm-lock.yaml` 记录 `qrcode`；不引入网络二维码服务。

- [ ] **Step 2: 写 Controller/service 失败测试**

```ts
it("does not return paymentUrl from a detail DTO", async () => {
  await expect(
    controller.detail("order-1", "user-1"),
  ).resolves.not.toHaveProperty("paymentUrl");
});

it("returns a no-store PNG response only for a pending, owned, unexpired order", async () => {
  await controller.paymentQr("order-1", "user-1", response);
  expect(response.type).toHaveBeenCalledWith("image/png");
  expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
});
```

- [ ] **Step 3: 实现游标列表、详情和刷新**

```ts
async list(userId: string, query: { cursor?: string; limit?: number }) {
  const rows = await prisma.mcDonaldsOrder.findMany({
    where: { userId }, orderBy: { createdAt: 'desc' }, take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  return { items: rows.slice(0, limit).map(toOrderCardDto), hasMore, nextCursor };
}
```

`refresh(id, userId)` 必须先 `findOwnedOrder()`，再 `isMcDonaldsTokenOwner(userId)`；调用 `getToolByMcpName('mcdonalds', 'query-order').invoke({ orderId: externalOrderId })`。成功更新快照与 `lastRefreshedAt` 并创建 `McDonaldsOrderRefresh(SUCCESS)`；失败创建 `ERROR` 审计后重新抛出，不覆盖旧订单状态。

- [ ] **Step 4: 实现受限支付端点**

`getPaymentLink()` 校验订单属主、`isPendingPayment(status)`、`paymentUrlCiphertext` 存在、有效期未过；只返回内存解密的 `{ url, expiresAt }`。二维码方法读取同一链接，`QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 480 })`，设置 `Content-Type: image/png` 和 `Cache-Control: no-store` 后写 response。

- [ ] **Step 5: 运行 API 测试、生成 OpenAPI 与 build**

Run: `pnpm --filter ./apps/api exec jest --runInBand --watchman=false src/modules/mcdonalds-order/mcdonalds-order.controller.spec.ts src/modules/mcdonalds-order/mcdonalds-order.service.spec.ts`
Run: `pnpm --filter ./apps/api run build`
Run: `pnpm --filter ./apps/api run export:openapi`
Expected: 测试/build 通过，OpenAPI 反映五个订单端点。

## Task 4: 订单创建流式事件与会话历史回显

**Files:**

- Modify: `packages/types/src/protocol/events.ts`
- Modify: `packages/types/src/protocol/payloads.ts`
- Modify: `apps/api/src/modules/stream-task/stream-task.service.ts`
- Modify: `apps/api/src/modules/conversation/conversation.service.ts`
- Modify: `apps/api/src/modules/conversation/dto/conversation-response.dto.ts`
- Create: `apps/api/src/modules/stream-task/stream-task.service.spec.ts` (或扩展现有对应 spec)
- Create: `apps/api/src/modules/conversation/conversation.service.spec.ts` (或扩展现有对应 spec)

- [ ] **Step 1: 写 `order.created` 与历史回填失败测试**

```ts
expect(StreamTaskEventType.OrderCreated).toBe("order.created");
expect(payload).toEqual(
  expect.objectContaining({
    order: expect.not.objectContaining({ paymentUrl: expect.anything() }),
  }),
);
expect(conversation.messages[1].orders).toEqual([
  { id: "order-1", externalOrderId: "external-1" },
]);
```

- [ ] **Step 2: 扩展共享协议**

```ts
export interface McDonaldsOrderCardPayload {
  id: string;
  externalOrderId: string;
  status?: string | null;
  statusLabel?: string | null;
  storeName?: string | null;
  fulfillmentType?: string | null;
  totalAmount?: string | null;
  discountAmount?: string | null;
  currency?: string | null;
  items: McDonaldsOrderItem[];
  lastRefreshedAt?: string | null;
}
export interface OrderCreatedPayload {
  order: McDonaldsOrderCardPayload;
}
```

新增 enum 值、中文标签和 `StreamTaskPayloadMap` 条目；所有数字金额作为字符串跨线传输，避免 Decimal 精度/JSON 类型漂移。

- [ ] **Step 3: 发送安全订单事件**

在 `handleAgentLoopStatusEvent()` 处理 `ToolCallDone` 后消费 `consumeCreatedMcDonaldsOrderIds()`，按本地订单 ID 读取 `toOrderCardDto()`，对每条订单 `persistEvent -> publish -> recordConversationTraceEvent`。trace mapper 对 `OrderCreated` 返回 `null`，因为工具 trace 已是唯一调用审计，不额外复制一条节点。

- [ ] **Step 4: 回填会话历史订单卡**

在 `ConversationService.findAllByUser()` 查询当前用户的订单，按 `messageId` 建 `Map<string, McDonaldsOrderCardDto[]>`，返回 DTO 时仅给对应 assistant message 添加 `orders`。查询必须显式 select 安全字段，禁止选 `paymentUrlCiphertext` 或 `rawSnapshot`。

- [ ] **Step 5: 运行共享包/API 测试与 build**

Run: `pnpm --filter ./apps/api exec jest --runInBand --watchman=false src/modules/stream-task/stream-task.service.spec.ts src/modules/conversation/conversation.service.spec.ts`
Run: `pnpm --filter ./apps/api run build`
Expected: 测试与 build 通过。

## Task 5: 生成客户端与移动端订单体验

**Files:**

- Modify: `apps/mobile/src/app.config.ts`
- Modify: `apps/mobile/src/pages/profile/index.tsx`
- Create: `apps/mobile/src/pages/orders/index.tsx`
- Create: `apps/mobile/src/pages/orders/index.config.ts`
- Create: `apps/mobile/src/pages/orders/detail.tsx`
- Create: `apps/mobile/src/pages/orders/detail.config.ts`
- Create: `apps/mobile/src/components/McdonaldsOrderCard/index.tsx`
- Create: `apps/mobile/src/components/McdonaldsPaymentSheet/index.tsx`
- Modify: `apps/mobile/src/components/ChatBubble/index.tsx`
- Modify: `apps/mobile/src/services/chat/chat-stream.service.ts`
- Modify: `apps/mobile/src/types/chat.d.ts`
- Generate: `apps/mobile/src/api/generated/**`

- [ ] **Step 1: 生成 API client，禁止手改生成文件**

Run in `apps/mobile/`: `pnpm generate:api:local`
Expected: OpenAPI 导出后 Orval 生成订单 endpoint、DTO 类型和 client 方法。

- [ ] **Step 2: 写订单卡和 SSE reducer 测试**

```ts
it("attaches order.created to the assistant message and never stores payment URL", () => {
  const next = applyStreamEvent(state, {
    type: StreamTaskEventType.OrderCreated,
    payload: safeOrderPayload,
  });
  expect(next.messages[messageId].orders).toEqual([safeOrderPayload.order]);
  expect(JSON.stringify(next)).not.toContain("payH5Url");
});
```

- [ ] **Step 3: 实现组合订单卡与支付弹层**

`McdonaldsOrderCard` 只接收安全卡 DTO：顶部状态/门店/预计时间，餐品/数量/规格/优惠/金额，底部进入详情。待支付时显示官方支付按钮；其它状态显示刷新按钮。无餐品时显示明确空状态“订单餐品明细待官方同步”，不显示假餐品。

`McdonaldsPaymentSheet`：H5 先调用 payment-link 再 `Taro.navigateTo`/浏览器跳转官方 URL；小程序请求二维码 endpoint，用本地临时文件展示，提供 `saveImageToPhotosAlbum` 和 `setClipboardData`。组件 state 只保留展示用二维码路径和请求中状态，不持久化支付 URL。

- [ ] **Step 4: 实现历史订单页与入口**

在 profile 的“账户服务”卡新增标准列表行“我的订单”。订单页按游标分页渲染卡片，详情页读详情、支持用户点击刷新。失败时保留已加载数据并显示错误；支付链接过期显示明确提示而不自动调用刷新。

- [ ] **Step 5: 处理聊天实时与历史订单**

从 `@litter-bear/types/protocol` 引入 `StreamTaskEventType.OrderCreated`，在 chat 流 reducer 将卡片插入 event 的 `messageId`，去重用本地订单 `id`。聊天历史直接读后端 `orders` 字段，统一用同一张 `McdonaldsOrderCard` 渲染。

- [ ] **Step 6: 运行移动端验证**

Run: `pnpm --filter ./apps/mobile run typecheck`
Run: `pnpm --filter ./apps/mobile run build:weapp`
Expected: TypeScript 与微信小程序构建通过。

## Task 6: 文档、全量回归与人工验证说明

**Files:**

- Modify: `docs/next-steps.md`
- Modify: `apps/api/docs/agent-loop-evolution.md`
- Modify: `apps/api/.env.example`
- Modify: `docs/superpowers/specs/2026-08-12-mcdonalds-order-p2-2-design.md`（只修正文档与实现不一致处）

- [ ] **Step 1: 更新项目文档**

记录：订单表与订单刷新审计的事实来源、`order.created` 是安全事件、支付 URL 加密/30 分钟期限、H5/小程序差异、手动刷新不经过 Agent、真实下单与支付仍需人工执行。

- [ ] **Step 2: 运行完整定向回归**

Run:

```bash
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run lint:check
pnpm --filter ./apps/api exec jest --runInBand --watchman=false \
  src/modules/mcdonalds-order \
  src/modules/ai/mcp/mcp-client-manager.service.spec.ts \
  src/modules/ai/agent-loop/capability/capability.registry.spec.ts \
  src/modules/conversation-trace/conversation-trace.service.spec.ts
pnpm --filter ./apps/mobile run typecheck
pnpm --filter ./apps/mobile run build:weapp
```

Expected: 全部通过。若 Prisma schema 已变更，只说明用户需要本地运行 `pnpm --filter ./apps/api run db:migrate`，不得手写或执行 migration SQL。

- [ ] **Step 3: 记录未自动执行的真实验证**

真实环境中，由 token 所属用户主动完成一次：聊天下单 → 两轮审批 → 订单卡 → 官方二维码/H5 支付 → 手动刷新。不得为了验证返回 schema 自动调用 `create-order`。

## 计划自查

- 规格覆盖：订单持久化、MCP 包装、订单历史、手动刷新、支付 URL 加密/过期、二维码、SSE、安全回填、前端卡片与错误状态均有对应任务。
- 占位检查：没有 `TODO`/`TBD` 或未定义的“适当处理”步骤。
- 类型一致性：跨线只使用 `McDonaldsOrderCardPayload`；数据库的金额 Decimal 在 DTO 中统一字符串；支付 URL 始终只经受限接口返回。
- 提交：仓库要求未获用户明确要求不得自动提交，因此本计划执行阶段不包含 commit。
