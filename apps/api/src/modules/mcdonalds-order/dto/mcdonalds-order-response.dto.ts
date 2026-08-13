import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** 麦当劳订单中可安全回显的餐品信息。 */
export class McDonaldsOrderItemDto {
  @ApiProperty({ description: '餐品名称', example: '巨无霸' })
  name: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1 })
  quantity: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '去洋葱' })
  specification: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '24.50' })
  unitPrice: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '24.50' })
  subtotal: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://example.com/burger.png',
  })
  imageUrl: string | null;
}

/** 麦当劳订单的安全详情和聊天卡片 DTO。 */
export class McDonaldsOrderResponseDto {
  @ApiProperty({ description: '本地订单 ID', example: 'cmf_mcd_order_123' })
  id: string;

  @ApiProperty({
    description: '麦当劳官方订单号',
    example: '1234567890123456789012345678901234',
  })
  externalOrderId: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'UNPAID' })
  status: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '待支付' })
  statusLabel: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '上海人民广场店',
  })
  storeName: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '到店取餐' })
  fulfillmentType: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '24.50' })
  totalAmount: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '5.00' })
  discountAmount: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'CNY' })
  currency: string | null;

  @ApiProperty({ type: McDonaldsOrderItemDto, isArray: true })
  items: McDonaldsOrderItemDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2026-08-12T12:30:00.000Z',
  })
  estimatedFulfillmentAt: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2026-08-12T12:10:00.000Z',
  })
  lastRefreshedAt: string | null;

  @ApiProperty({ example: '2026-08-12T12:00:00.000Z' })
  createdAt: string;

  @ApiProperty({
    description: '关联麦当劳凭据仍有效时为 true；false 时订单仅支持只读查看',
    example: true,
  })
  externalActionsAvailable: boolean;
}

/** 麦当劳订单分页结果。 */
export class McDonaldsOrderPageDto {
  @ApiProperty({ type: McDonaldsOrderResponseDto, isArray: true })
  items: McDonaldsOrderResponseDto[];

  @ApiProperty({ description: '是否还有下一页', example: false })
  hasMore: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '下一页游标',
  })
  nextCursor: string | null;
}

/** 仅供 H5 当前请求立即跳转的短时官方支付链接。 */
export class McDonaldsPaymentLinkDto {
  @ApiProperty({ description: '官方支付 URL，仅当前请求使用', format: 'uri' })
  url: string;

  @ApiProperty({
    description: '支付链接过期时间',
    example: '2026-08-12T12:30:00.000Z',
  })
  expiresAt: string;
}
