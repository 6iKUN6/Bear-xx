import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { McDonaldsOrderQueryDto } from './dto/mcdonalds-order-query.dto';
import {
  McDonaldsOrderPageDto,
  McDonaldsOrderResponseDto,
  McDonaldsPaymentLinkDto,
} from './dto/mcdonalds-order-response.dto';
import { McDonaldsOrderService } from './mcdonalds-order.service';

/** 麦当劳订单 REST 接口。 */
@ApiTags('麦当劳订单')
@ApiBearerAuth()
@Controller('mcdonalds-orders')
@UseGuards(JwtAuthGuard)
export class McDonaldsOrderController {
  constructor(private readonly mcdonaldsOrderService: McDonaldsOrderService) {}

  /**
   * 获取当前用户的麦当劳订单历史
   * @param userId 当前认证用户ID
   * @param query 游标分页参数
   * @returns 返回订单卡片分页结果
   * @description 订单按创建时间倒序返回，仅包含不会泄露支付会话的安全字段。
   */
  @Get()
  @ApiOperation({ summary: '获取我的麦当劳订单' })
  @ApiOkResponse({ type: McDonaldsOrderPageDto })
  list(
    @CurrentUser('id') userId: string,
    @Query() query: McDonaldsOrderQueryDto,
  ): Promise<McDonaldsOrderPageDto> {
    return this.mcdonaldsOrderService.list(userId, query);
  }

  /**
   * 获取一条订单的安全详情
   * @param id 本地订单ID
   * @param userId 当前认证用户ID
   * @returns 返回安全订单详情
   * @description 不返回支付链接、支付密文或 MCP 原始响应。
   */
  @Get(':id')
  @ApiOperation({ summary: '获取麦当劳订单详情' })
  @ApiOkResponse({ type: McDonaldsOrderResponseDto })
  detail(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ): Promise<McDonaldsOrderResponseDto> {
    return this.mcdonaldsOrderService.getDetail(id, userId);
  }

  /**
   * 用户主动刷新订单状态
   * @param id 本地订单ID
   * @param userId 当前认证用户ID
   * @returns 返回同步后的安全订单详情
   * @description 直接调用审核后的 query-order，不经过 Agent、LLM 或 HITL，并写入订单域刷新审计。
   */
  @Post(':id/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '刷新麦当劳订单状态' })
  @ApiOkResponse({ type: McDonaldsOrderResponseDto })
  refresh(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ): Promise<McDonaldsOrderResponseDto> {
    return this.mcdonaldsOrderService.refresh(id, userId);
  }

  /**
   * 获取短时官方支付链接
   * @param id 本地订单ID
   * @param userId 当前认证用户ID
   * @returns 返回仅用于本次跳转的官方支付 URL 与过期时间
   * @description 仅待支付、属主匹配且未过期的订单可读取；调用方不得将返回 URL 持久化。
   */
  @Post(':id/payment-link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '获取官方支付链接（H5）' })
  @ApiOkResponse({ type: McDonaldsPaymentLinkDto })
  paymentLink(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ): Promise<McDonaldsPaymentLinkDto> {
    return this.mcdonaldsOrderService.getPaymentLink(id, userId);
  }

  /**
   * 获取官方支付链接二维码 PNG
   * @param id 本地订单ID
   * @param userId 当前认证用户ID
   * @param response Express 原始响应对象
   * @returns 无返回值
   * @description 二维码即时在内存生成且禁止缓存，适用于无法携带 JWT header 的微信小程序 Image 组件场景。
   */
  @Get(':id/payment-qr')
  @ApiProduces('image/png')
  @ApiOperation({ summary: '获取官方支付二维码（小程序）' })
  @ApiOkResponse({
    description: '官方支付 URL 编码后的 PNG，不可缓存',
    content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
  })
  async paymentQr(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Res() response: Response,
  ): Promise<void> {
    const png = await this.mcdonaldsOrderService.getPaymentQr(id, userId);
    response.type('image/png');
    response.setHeader('Cache-Control', 'no-store');
    response.send(png);
  }
}
