import { parseMcDonaldsOrderResponse } from './mcdonalds-order.parser';

describe('parseMcDonaldsOrderResponse', () => {
  it('提取嵌套订单号并从安全快照中剥离支付链接', () => {
    const raw = {
      data: {
        orderId: 'external-1',
        payH5Url: 'https://pay.example/session',
        status: 'UNPAID',
        store: { name: '上海人民广场店' },
        items: [{ name: '巨无霸', quantity: 1, price: '24.50' }],
      },
    };

    const result = parseMcDonaldsOrderResponse(raw);

    expect(result.externalOrderId).toBe('external-1');
    expect(result.paymentUrl).toBe('https://pay.example/session');
    expect(result.status).toBe('UNPAID');
    expect(result.items).toEqual([
      { name: '巨无霸', quantity: 1, price: '24.50' },
    ]);
    expect(JSON.stringify(result.safeSnapshot)).not.toContain('pay.example');
    expect(raw.data).toHaveProperty('payH5Url', 'https://pay.example/session');
  });

  it('识别内容字符串中的支付链接并在没有官方订单号时不创建猜测值', () => {
    const result = parseMcDonaldsOrderResponse({
      content: JSON.stringify({
        data: {
          accepted: true,
          paymentLink: 'https://pay.example/second-session',
        },
      }),
    });

    expect(result.externalOrderId).toBeUndefined();
    expect(result.paymentUrl).toBe('https://pay.example/second-session');
    expect(JSON.stringify(result.safeSnapshot)).not.toContain('pay.example');
  });

  it('提取官方支付链接的明确到期时间，并剥离 payUrl 别名', () => {
    const result = parseMcDonaldsOrderResponse({
      data: {
        orderId: 'external-1',
        payUrl: 'https://pay.example/alternate-session',
        payUrlExpiresAt: '2026-08-13T01:40:00.000Z',
      },
    });

    expect(result).toMatchObject({
      paymentUrl: 'https://pay.example/alternate-session',
      paymentUrlExpiresAt: new Date('2026-08-13T01:40:00.000Z'),
    });
    expect(JSON.stringify(result.safeSnapshot)).not.toContain('pay.example');
  });

  it('不把仅有的支付链接到期字段误判为支付链接', () => {
    const result = parseMcDonaldsOrderResponse({
      data: {
        orderId: 'external-1',
        paymentUrlExpiresAt: '2026-08-13T01:40:00.000Z',
      },
    });

    expect(result.paymentUrl).toBeUndefined();
    expect(result.paymentUrlExpiresAt).toEqual(
      new Date('2026-08-13T01:40:00.000Z'),
    );
  });
});
