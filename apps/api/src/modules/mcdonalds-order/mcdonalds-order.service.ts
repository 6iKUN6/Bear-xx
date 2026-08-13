import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { Prisma } from '@prisma/client';
import QRCode from 'qrcode';
import {
  McpClientManager,
  type McpToolMetadata,
} from '../ai/mcp/mcp-client-manager.service';
import { McDonaldsCredentialService } from '../mcdonalds-credential/mcdonalds-credential.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  registerCreatedMcDonaldsOrder,
  requireMcDonaldsOrderContext,
} from './mcdonalds-order-context';
import { parseMcDonaldsOrderResponse } from './mcdonalds-order.parser';
import type { ParsedMcDonaldsOrder } from './mcdonalds-order.types';
import type {
  McDonaldsOrderCard,
  McDonaldsOrderItem,
} from './mcdonalds-order.types';
import { PaymentUrlCryptoService } from './payment-url-crypto.service';

const PAYMENT_URL_TTL_MS = 30 * 60 * 1000;
const DEFAULT_ORDER_PAGE_LIMIT = 20;
const PENDING_PAYMENT_STATUSES = new Set([
  'UNPAID',
  'PENDING_PAYMENT',
  'WAIT_PAY',
  'WAITING_PAYMENT',
  'TO_BE_PAID',
]);

interface OrderCardSource {
  id: string;
  externalOrderId: string;
  status: string | null;
  statusLabel: string | null;
  storeName: string | null;
  fulfillmentType: string | null;
  totalAmount: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal | null;
  currency: string | null;
  items: Prisma.JsonValue | null;
  estimatedFulfillmentAt: Date | null;
  lastRefreshedAt: Date | null;
  createdAt: Date;
  credential?: { status: string } | null;
}

interface ParsedOrderPersistenceData {
  status?: string;
  statusLabel?: string;
  storeCode?: string;
  storeName?: string;
  orderType?: number;
  fulfillmentType?: string;
  estimatedFulfillmentAt?: Date;
  totalAmount?: Prisma.Decimal;
  discountAmount?: Prisma.Decimal;
  currency?: string;
  items?: Prisma.InputJsonValue;
  rawSnapshot: Prisma.InputJsonValue;
  paymentUrlCiphertext?: string;
  paymentUrlExpiresAt?: Date;
}

/**
 * 麦当劳订单领域服务
 * @description 负责将受审核 MCP 的 create-order/query-order 包装为安全 Agent 工具；订单持久化、支付链接与刷新行为会在同一领域服务中集中实现。
 */
@Injectable()
export class McDonaldsOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentUrlCryptoService: PaymentUrlCryptoService,
    private readonly mcpClientManager: McpClientManager,
    private readonly mcdonaldsCredentialService: McDonaldsCredentialService,
  ) {}

  /**
   * 校验麦当劳订单支付链接加密配置
   * @returns 无返回值
   * @description MCP 工具组注册前调用，保证已经启用的下单能力不会在创建官方订单后因缺少加密密钥而无法安全持久化。
   */
  assertPaymentUrlEncryptionConfigured(): void {
    this.paymentUrlCryptoService.assertConfigured();
  }

  /**
   * 包装可被 Agent 注入的麦当劳 MCP 工具
   * @param rawTool 已经完成 tools/list 白名单审核的原始 MCP 工具
   * @param metadata 原始 MCP server 与工具名元数据
   * @returns 返回保留名称、描述和 schema 的安全工具包装
   * @description 仅 create-order 写订单领域事实；query-order 会移除支付链接后再返回模型，其他工具不应经过此方法。
   */
  wrapAgentTool(
    rawTool: DynamicStructuredTool,
    metadata: McpToolMetadata,
  ): DynamicStructuredTool {
    if (metadata.mcpTool === 'create-order') {
      return new DynamicStructuredTool({
        name: rawTool.name,
        description: rawTool.description,
        schema: rawTool.schema,
        func: async (input) => this.invokeCreateOrder(rawTool, input),
      });
    }

    return new DynamicStructuredTool({
      name: rawTool.name,
      description: rawTool.description,
      schema: rawTool.schema,
      func: async (input) => this.invokeSafeQueryOrder(rawTool, input),
    });
  }

  /**
   * 按订单模型格式返回安全卡片字段
   * @param order 已持久化的麦当劳订单
   * @returns 返回不会包含支付链接、密文或原始快照的订单卡片字段
   * @description SSE、会话历史和 REST DTO 共用该转换，避免不同出口意外泄露敏感字段。
   */
  toOrderCard(order: OrderCardSource): McDonaldsOrderCard {
    return {
      id: order.id,
      externalOrderId: order.externalOrderId,
      status: order.status,
      statusLabel: order.statusLabel,
      storeName: order.storeName,
      fulfillmentType: order.fulfillmentType,
      totalAmount: order.totalAmount?.toString() ?? null,
      discountAmount: order.discountAmount?.toString() ?? null,
      currency: order.currency,
      items: normalizeOrderItems(order.items),
      estimatedFulfillmentAt:
        order.estimatedFulfillmentAt?.toISOString() ?? null,
      lastRefreshedAt: order.lastRefreshedAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      externalActionsAvailable: order.credential?.status === 'ACTIVE',
    };
  }

  /**
   * 分页读取当前用户的历史订单
   * @param userId 当前认证用户ID
   * @param query 游标与页面大小
   * @returns 返回安全订单卡片、下一页游标与更多标记
   * @description 只读取该用户订单，支付链接密文和原始 MCP 快照不会进入查询或返回对象。
   */
  async list(
    userId: string,
    query: { cursor?: string; limit?: number },
  ): Promise<{
    items: McDonaldsOrderCard[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const limit = query.limit ?? DEFAULT_ORDER_PAGE_LIMIT;
    const rows = await this.prisma.mcDonaldsOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: orderCardSelect,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((order) => this.toOrderCard(order)),
      hasMore,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * 读取当前用户一条订单的安全详情
   * @param id 本地订单ID
   * @param userId 当前认证用户ID
   * @returns 返回安全订单卡片字段
   * @description 基于订单ID和用户ID联合读取，查询列显式排除支付链接密文和原始响应快照。
   */
  async getDetail(id: string, userId: string): Promise<McDonaldsOrderCard> {
    const order = await this.prisma.mcDonaldsOrder.findFirst({
      where: { id, userId },
      select: orderCardSelect,
    });
    if (!order) {
      throw new NotFoundException('订单不存在或无权访问');
    }
    return this.toOrderCard(order);
  }

  /**
   * 批量读取任务内新建订单的安全卡片
   * @param ids 本地订单ID列表
   * @param userId 当前任务所属用户ID
   * @returns 返回按传入ID顺序排列的安全订单卡片
   * @description 供 StreamTask 发布 order.created 使用；从查询投影层明确排除支付密文与原始 MCP 快照。
   */
  async getCardsByIds(
    ids: string[],
    userId: string,
  ): Promise<McDonaldsOrderCard[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.mcDonaldsOrder.findMany({
      where: { id: { in: ids }, userId },
      select: orderCardSelect,
    });
    const cardById = new Map(
      rows.map((order) => [order.id, this.toOrderCard(order)]),
    );
    return ids.flatMap((id) => {
      const card = cardById.get(id);
      return card ? [card] : [];
    });
  }

  /**
   * 用户主动刷新官方订单状态
   * @param id 本地订单ID
   * @param userId 当前认证用户ID
   * @returns 返回更新后的安全订单卡片
   * @description 直接复用启动期审核的 query-order 工具，不经过 Agent/LLM，并无论成功失败都写订单刷新审计。
   */
  async refresh(id: string, userId: string): Promise<McDonaldsOrderCard> {
    const order = await this.findOwnedOrder(id, userId);
    const access = await this.mcdonaldsCredentialService.requireActiveAccess(
      userId,
      order.credentialId ?? undefined,
    );
    const startedAt = new Date();
    try {
      const queryOrderTool = await this.mcpClientManager.getMcDonaldsToolByName(
        access.credentialId,
        access.token,
        'query-order',
      );
      const rawResponse: unknown = await queryOrderTool.invoke({
        orderId: order.externalOrderId,
      });
      const parsed = parseMcDonaldsOrderResponse(rawResponse);
      const updated = await this.prisma.mcDonaldsOrder.update({
        where: { id: order.id },
        data: {
          ...this.updateOrderPersistenceData(parsed),
          lastRefreshedAt: new Date(),
        },
      });
      await this.prisma.mcDonaldsOrderRefresh.create({
        data: {
          orderId: order.id,
          status: 'SUCCESS',
          statusAfter: updated.status,
          safeSnapshot: this.toInputJsonValue(parsed.safeSnapshot),
          startedAt,
          completedAt: new Date(),
        },
      });
      return this.toOrderCard({
        ...updated,
        credential: { status: 'ACTIVE' },
      });
    } catch (error) {
      await this.prisma.mcDonaldsOrderRefresh.create({
        data: {
          orderId: order.id,
          status: 'ERROR',
          errorMessage: sanitizeErrorMessage(error),
          startedAt,
          completedAt: new Date(),
        },
      });
      throw new BadRequestException('订单状态刷新失败，请稍后重试');
    }
  }

  /**
   * 解密当前请求可使用的官方支付链接
   * @param id 本地订单ID
   * @param userId 当前认证用户ID
   * @returns 返回支付 URL 与其到期时间
   * @description 仅待支付、订单属主和链接未过期三项均满足时返回明文；结果不得被持久化或写入日志。
   */
  async getPaymentLink(
    id: string,
    userId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const order = await this.findOwnedOrder(id, userId);
    await this.mcdonaldsCredentialService.requireActiveAccess(
      userId,
      order.credentialId ?? undefined,
    );
    if (!isPendingPayment(order.status)) {
      throw new BadRequestException('当前订单不处于待支付状态');
    }
    if (!order.paymentUrlCiphertext || !order.paymentUrlExpiresAt) {
      throw new BadRequestException('当前订单没有可用的官方支付链接');
    }
    this.paymentUrlCryptoService.assertNotExpired(order.paymentUrlExpiresAt);
    return {
      url: this.paymentUrlCryptoService.decrypt(order.paymentUrlCiphertext),
      expiresAt: order.paymentUrlExpiresAt.toISOString(),
    };
  }

  /**
   * 即时生成官方支付二维码 PNG
   * @param id 本地订单ID
   * @param userId 当前认证用户ID
   * @returns 返回内存中的 PNG 字节
   * @description 只在支付链接授权校验之后编码，二维码不落库、不缓存，也不会进入聊天或任务事件。
   */
  async getPaymentQr(id: string, userId: string): Promise<Buffer> {
    const { url } = await this.getPaymentLink(id, userId);
    return QRCode.toBuffer(url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 480,
    });
  }

  private async invokeCreateOrder(
    rawTool: DynamicStructuredTool,
    input: unknown,
  ): Promise<string> {
    await this.requireActiveContextCredential();
    const rawResponse: unknown = await rawTool.invoke(input);
    const parsed = parseMcDonaldsOrderResponse(rawResponse);
    if (!parsed.externalOrderId) {
      return '订单已提交，但未识别到官方订单号，请到麦当劳官方渠道核实。';
    }

    const context = requireMcDonaldsOrderContext();
    const credentialId = this.requireCredentialId(
      context.mcdonaldsCredentialId,
    );
    const order = await this.prisma.mcDonaldsOrder.upsert({
      where: {
        userId_credentialId_externalOrderId: {
          userId: context.userId,
          credentialId,
          externalOrderId: parsed.externalOrderId,
        },
      },
      create: this.createOrderPersistenceData(context, parsed, input),
      update: this.updateOrderPersistenceData(parsed),
    });
    registerCreatedMcDonaldsOrder(order.id);
    return this.formatSafeAgentOrderResult(order);
  }

  private async invokeSafeQueryOrder(
    rawTool: DynamicStructuredTool,
    input: unknown,
  ): Promise<string> {
    await this.requireActiveContextCredential();
    const rawResponse: unknown = await rawTool.invoke(input);
    const parsed = parseMcDonaldsOrderResponse(rawResponse);
    return JSON.stringify(parsed.safeSnapshot);
  }

  private createOrderPersistenceData(
    context: ReturnType<typeof requireMcDonaldsOrderContext>,
    parsed: ParsedMcDonaldsOrder,
    input: unknown,
  ): Prisma.McDonaldsOrderCreateInput {
    const common = this.buildParsedOrderData(parsed, input);
    const credentialId = this.requireCredentialId(
      context.mcdonaldsCredentialId,
    );
    return {
      ...common,
      currency: common.currency ?? 'CNY',
      user: { connect: { id: context.userId } },
      credential: { connect: { id: credentialId } },
      conversation: context.conversationId
        ? { connect: { id: context.conversationId } }
        : undefined,
      message: context.messageId
        ? { connect: { id: context.messageId } }
        : undefined,
      task: { connect: { id: context.taskId } },
      externalOrderId: this.requireExternalOrderId(parsed),
    };
  }

  /**
   * 生成刷新或幂等更新所需的安全字段
   * @param parsed 已脱敏的 MCP 订单响应
   * @returns 返回可用于 Prisma update 的订单字段
   * @description 没有出现在 MCP 响应中的字段保持 undefined，Prisma 因而不会覆盖已有订单事实。
   */
  private updateOrderPersistenceData(
    parsed: ParsedMcDonaldsOrder,
  ): Prisma.McDonaldsOrderUpdateInput {
    return this.buildParsedOrderData(parsed);
  }

  /**
   * 从解析结果与下单参数归一化可持久化字段
   * @param parsed 已脱敏的 MCP 响应
   * @param input 可选的原始工具入参，仅用于补充响应未回传的门店和履约方式
   * @returns 返回不含归属关系和官方订单号的安全持久化字段
   * @description 支付链接会立即加密，安全快照始终来自已删除支付 URL 的解析结果。
   */
  private buildParsedOrderData(
    parsed: ParsedMcDonaldsOrder,
    input?: unknown,
  ): ParsedOrderPersistenceData {
    const paymentUrl = parsed.paymentUrl;
    return {
      status: parsed.status,
      statusLabel: findString(parsed.safeSnapshot, [
        'statuslabel',
        'statusname',
        'orderstatusname',
      ]),
      storeCode:
        findString(parsed.safeSnapshot, ['storecode']) ??
        findString(input, ['storecode']),
      storeName: findString(parsed.safeSnapshot, ['storename', 'shopname']),
      orderType:
        findInteger(parsed.safeSnapshot, ['ordertype']) ??
        findInteger(input, ['ordertype']),
      fulfillmentType: findString(parsed.safeSnapshot, [
        'fulfillmenttype',
        'taketype',
        'deliverytype',
      ]),
      estimatedFulfillmentAt: findDate(parsed.safeSnapshot, [
        'estimateddeliveryat',
        'estimatedreadyat',
        'estimatedtime',
      ]),
      totalAmount: findDecimal(parsed.safeSnapshot, [
        'totalamount',
        'payamount',
        'actualamount',
      ]),
      discountAmount: findDecimal(parsed.safeSnapshot, [
        'discountamount',
        'discount',
      ]),
      currency: findString(parsed.safeSnapshot, ['currency']),
      items: parsed.items ? this.toInputJsonValue(parsed.items) : undefined,
      rawSnapshot: this.toInputJsonValue(parsed.safeSnapshot),
      paymentUrlCiphertext: paymentUrl
        ? this.paymentUrlCryptoService.encrypt(paymentUrl)
        : undefined,
      paymentUrlExpiresAt: paymentUrl
        ? this.resolvePaymentUrlExpiresAt(parsed.paymentUrlExpiresAt)
        : undefined,
    };
  }

  /**
   * 计算支付链接的本地保存到期时间
   * @param officialExpiresAt MCP 返回的可选官方到期时间
   * @returns 返回官方时间与本地三十分钟上限中的较早值
   * @description 远端未给有效期时维持最短必要保存时间；给出有效期时绝不延长官方支付会话。
   */
  private resolvePaymentUrlExpiresAt(officialExpiresAt?: Date): Date {
    const localExpiry = new Date(Date.now() + PAYMENT_URL_TTL_MS);
    if (!officialExpiresAt) {
      return localExpiry;
    }
    return officialExpiresAt.getTime() < localExpiry.getTime()
      ? officialExpiresAt
      : localExpiry;
  }

  /**
   * 读取可作为幂等键的官方订单号
   * @param parsed MCP 订单解析结果
   * @returns 返回非空的官方订单号
   * @description create-order 在未识别官方订单号时不得落库；该方法仅作为内部断言防御遗漏调用。
   */
  private requireExternalOrderId(parsed: ParsedMcDonaldsOrder): string {
    if (!parsed.externalOrderId) {
      throw new Error('缺少可持久化的麦当劳官方订单号');
    }
    return parsed.externalOrderId;
  }

  /**
   * 读取当前聊天任务锁定的麦当劳凭据
   * @param credentialId 订单上下文中的凭据ID
   * @returns 返回非空的凭据ID
   * @description 下单必须关联创建时的用户级凭据；缺失时拒绝入库，防止产生无法安全刷新或支付的订单。
   */
  private requireCredentialId(credentialId: string | undefined): string {
    if (!credentialId) {
      throw new BadRequestException('请先绑定有效的麦当劳 MCP Token');
    }
    return credentialId;
  }

  /**
   * 确认当前 Agent 工具调用关联的凭据仍可使用
   * @returns 无返回值
   * @description 工具在装配后可能经过 HITL 等待期；执行前必须复核任务锁定的凭据仍归属当前用户且处于 ACTIVE，
   * 避免解绑或换绑后继续使用已经缓存的 MCP client 访问旧账号。
   */
  private async requireActiveContextCredential(): Promise<void> {
    const context = requireMcDonaldsOrderContext();
    await this.mcdonaldsCredentialService.requireActiveAccess(
      context.userId,
      this.requireCredentialId(context.mcdonaldsCredentialId),
    );
  }

  /**
   * 构建提供给模型的安全下单摘要
   * @param order 已入库订单
   * @returns 返回不含支付 URL 和原始响应的文字摘要
   * @description 模型只需知道订单已创建、订单号和可回显的状态金额，支付跳转由前端专用端点处理。
   */
  private formatSafeAgentOrderResult(order: OrderCardSource): string {
    const fragments = [
      `已创建麦当劳订单，官方订单号：${order.externalOrderId}`,
    ];
    if (order.status) {
      fragments.push(`当前状态：${order.status}`);
    }
    if (order.storeName) {
      fragments.push(`门店：${order.storeName}`);
    }
    if (order.totalAmount) {
      fragments.push(
        `金额：${order.totalAmount.toString()} ${order.currency ?? 'CNY'}`,
      );
    }
    return fragments.join('；');
  }

  /**
   * 归一化为 Prisma 可写入的 JSON 值
   * @param value 待写入的安全 JSON 值
   * @returns 返回可由 Prisma 持久化的深拷贝 JSON 值
   * @description 通过 JSON round-trip 去除原型和不可序列化值，调用方只传入已脱敏的 MCP 数据。
   */
  private toInputJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  /**
   * 按订单属主读取包含支付密文的内部订单实体
   * @param id 本地订单ID
   * @param userId 当前认证用户ID
   * @returns 返回仅供订单服务内部处理的订单实体
   * @description 该查询只供刷新和支付授权链路使用，禁止将实体直接返回给 Controller 或 SSE。
   */
  private async findOwnedOrder(id: string, userId: string) {
    const order = await this.prisma.mcDonaldsOrder.findFirst({
      where: { id, userId },
    });
    if (!order) {
      throw new NotFoundException('订单不存在或无权访问');
    }
    return order;
  }
}

const orderCardSelect = {
  id: true,
  externalOrderId: true,
  status: true,
  statusLabel: true,
  storeName: true,
  fulfillmentType: true,
  totalAmount: true,
  discountAmount: true,
  currency: true,
  items: true,
  estimatedFulfillmentAt: true,
  lastRefreshedAt: true,
  createdAt: true,
  credential: { select: { status: true } },
} as const;

/**
 * 将餐品 JSON 快照规范成安全回显字段
 * @param value MCP 返回的已脱敏餐品数组
 * @returns 返回名称明确的餐品列表
 * @description MCP 结果 schema 不稳定；无法识别名称的条目不回显，页面以明确空状态代替伪造餐品。
 */
function normalizeOrderItems(
  value: Prisma.JsonValue | null,
): McDonaldsOrderItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const name = findString(item, ['name', 'productname', 'itemname', 'title']);
    if (!name) {
      return [];
    }
    return [
      {
        name,
        quantity: findInteger(item, ['quantity', 'count', 'num']) ?? null,
        specification:
          findString(item, [
            'specification',
            'spec',
            'customization',
            'remark',
          ]) ?? null,
        unitPrice:
          findDecimal(item, ['unitprice', 'price', 'saleprice'])?.toString() ??
          null,
        subtotal:
          findDecimal(item, [
            'subtotal',
            'totalamount',
            'amount',
          ])?.toString() ?? null,
        imageUrl:
          findString(item, ['imageurl', 'image', 'pictureurl', 'picture']) ??
          null,
      },
    ];
  });
}

/**
 * 判断订单状态是否明确表示待支付
 * @param status 官方订单状态
 * @returns 明确待支付返回 true
 * @description 未知状态一律拒绝读取支付链接，避免因 MCP 枚举变动在完成/取消订单上继续暴露旧支付会话。
 */
function isPendingPayment(status: string | null): boolean {
  return Boolean(status && PENDING_PAYMENT_STATUSES.has(status.toUpperCase()));
}

/**
 * 脱敏刷新失败摘要
 * @param error 捕获到的任意错误
 * @returns 返回可安全记录到订单刷新审计的单行错误信息
 * @description 外部错误可能包含 URL 或查询参数，审计只保留有限长度的脱敏文本。
 */
function sanitizeErrorMessage(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  return source.replace(/https?:\/\/[^\s]+/giu, '[已隐藏链接]').slice(0, 500);
}

function findString(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  return findByKeys(value, keys, (candidate) =>
    typeof candidate === 'string' && candidate.trim()
      ? candidate.trim()
      : undefined,
  );
}

function findInteger(
  value: unknown,
  keys: readonly string[],
): number | undefined {
  return findByKeys(value, keys, (candidate) => {
    const number =
      typeof candidate === 'number' ? candidate : Number(candidate);
    return Number.isInteger(number) ? number : undefined;
  });
}

function findDecimal(
  value: unknown,
  keys: readonly string[],
): Prisma.Decimal | undefined {
  return findByKeys(value, keys, (candidate) => {
    const normalized =
      typeof candidate === 'number' ? String(candidate) : candidate;
    if (typeof normalized !== 'string' || !/^-?\d+(\.\d+)?$/.test(normalized)) {
      return undefined;
    }
    return new Prisma.Decimal(normalized);
  });
}

function findDate(value: unknown, keys: readonly string[]): Date | undefined {
  return findByKeys(value, keys, (candidate) => {
    if (typeof candidate !== 'string' && typeof candidate !== 'number') {
      return undefined;
    }
    const date = new Date(candidate);
    return Number.isNaN(date.getTime()) ? undefined : date;
  });
}

function findByKeys<T>(
  value: unknown,
  keys: readonly string[],
  accept: (candidate: unknown) => T | undefined,
): T | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findByKeys(item, keys, accept);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key.toLowerCase())) {
      const accepted = accept(child);
      if (accepted !== undefined) {
        return accepted;
      }
    }
  }
  for (const child of Object.values(value)) {
    const match = findByKeys(child, keys, accept);
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
