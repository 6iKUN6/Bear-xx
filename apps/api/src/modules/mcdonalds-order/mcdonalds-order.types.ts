/** 麦当劳 MCP 返回值完成脱敏后的订单解析结果。 */
export interface ParsedMcDonaldsOrder {
  /** MCP 响应中可识别的官方订单号；未识别时为 undefined。 */
  externalOrderId?: string;
  /** 仅供服务层立即加密落库的官方支付链接，绝不能对外返回。 */
  paymentUrl?: string;
  /** MCP 明确返回的支付链接到期时间；无效或缺失时为 undefined。 */
  paymentUrlExpiresAt?: Date;
  /** 已递归删除支付跳转字段的原始响应快照。 */
  safeSnapshot: Record<string, unknown>;
  /** 官方返回的原始订单状态。 */
  status?: string;
  /** 官方返回的餐品数组快照。 */
  items?: unknown[];
}

/** 对外回显的单个餐品信息。 */
export interface McDonaldsOrderItem {
  name: string;
  quantity: number | null;
  specification: string | null;
  unitPrice: string | null;
  subtotal: string | null;
  imageUrl: string | null;
}

/** SSE、会话历史与 REST 共用的安全订单卡片。 */
export interface McDonaldsOrderCard {
  id: string;
  externalOrderId: string;
  status: string | null;
  statusLabel: string | null;
  storeName: string | null;
  fulfillmentType: string | null;
  totalAmount: string | null;
  discountAmount: string | null;
  currency: string | null;
  items: McDonaldsOrderItem[];
  estimatedFulfillmentAt: string | null;
  lastRefreshedAt: string | null;
  createdAt: string;
  /** 关联麦当劳凭据仍有效时才允许刷新或跳转官方支付。 */
  externalActionsAvailable: boolean;
}
