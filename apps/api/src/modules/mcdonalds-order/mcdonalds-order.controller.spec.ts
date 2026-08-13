import { BadRequestException } from '@nestjs/common';
import { McDonaldsOrderController } from './mcdonalds-order.controller';

describe('McDonaldsOrderController', () => {
  const createService = () => ({
    getDetail: jest.fn(),
    getPaymentQr: jest.fn(),
  });

  it('详情接口不会返回支付链接', async () => {
    const service = createService();
    service.getDetail.mockResolvedValue({
      id: 'order-1',
      externalOrderId: 'external-1',
      status: 'UNPAID',
    });
    const controller = new McDonaldsOrderController(service as never);

    const result = await controller.detail('order-1', 'user-1');

    expect(result).not.toHaveProperty('paymentUrl');
  });

  it('二维码接口以禁止缓存的 PNG 响应官方支付链接', async () => {
    const service = createService();
    service.getPaymentQr.mockResolvedValue(Buffer.from('png'));
    const controller = new McDonaldsOrderController(service as never);
    const response = {
      type: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      send: jest.fn(),
    };

    await controller.paymentQr('order-1', 'user-1', response as never);

    expect(response.type).toHaveBeenCalledWith('image/png');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(response.send).toHaveBeenCalledWith(Buffer.from('png'));
  });

  it('支付链接失败会保持明确的业务异常', async () => {
    const service = createService();
    service.getDetail.mockRejectedValue(
      new BadRequestException('支付链接已过期'),
    );
    const controller = new McDonaldsOrderController(service as never);

    await expect(controller.detail('order-1', 'user-1')).rejects.toThrow(
      '支付链接已过期',
    );
  });
});
