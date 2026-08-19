import { ConfigService } from '@nestjs/config';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { McDonaldsOrderService } from './mcdonalds-order.service';
import { runWithMcDonaldsOrderContext } from './mcdonalds-order-context';
import { PaymentUrlCryptoService } from './payment-url-crypto.service';

describe('McDonaldsOrderService', () => {
  const createPrismaMock = () => ({
    mcDonaldsOrder: {
      upsert: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    mcDonaldsOrderRefresh: { create: jest.fn() },
  });

  const createMcpClientManagerMock = () => ({
    getMcDonaldsToolByName: jest.fn(),
  });

  const createCredentialServiceMock = () => ({
    requireActiveAccess: jest.fn().mockResolvedValue({
      credentialId: 'credential-1',
      token: 'token-1',
    }),
  });

  function createService(
    prisma: ReturnType<typeof createPrismaMock>,
    manager = createMcpClientManagerMock(),
    credentialService = createCredentialServiceMock(),
  ) {
    return {
      service: new McDonaldsOrderService(
        prisma as never,
        new PaymentUrlCryptoService(
          new ConfigService({
            MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString(
              'base64',
            ),
          }),
        ),
        manager as never,
        credentialService as never,
      ),
      manager,
      credentialService,
    };
  }

  function createRawCreateOrderTool(response: unknown): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'mcdonalds__create-order',
      description: '创建麦当劳订单',
      schema: z.object({ storeCode: z.string() }),
      func: () => Promise.resolve(JSON.stringify(response)),
    });
  }

  it('包装下单工具后按用户与官方订单号幂等入库且不向模型泄露支付链接', async () => {
    const prisma = createPrismaMock();
    prisma.mcDonaldsOrder.upsert.mockResolvedValue({
      id: 'order-1',
      externalOrderId: 'external-1',
      status: 'UNPAID',
      storeName: '上海人民广场店',
      totalAmount: { toString: () => '24.50' },
      currency: 'CNY',
    });
    const { service, credentialService } = createService(prisma);
    const rawTool = createRawCreateOrderTool({
      data: {
        orderId: 'external-1',
        payH5Url: 'https://pay.example/session',
        status: 'UNPAID',
        storeName: '上海人民广场店',
        totalAmount: '24.50',
      },
    });

    await runWithMcDonaldsOrderContext(
      'task-1',
      'user-1',
      async () => {
        const result = await service
          .wrapAgentTool(rawTool, {
            mcpServer: 'mcdonalds',
            mcpTool: 'create-order',
          })
          .invoke({ storeCode: 'store-1' });

        expect(result).not.toContain('pay.example');
      },
      undefined,
      { mcdonaldsCredentialId: 'credential-1' },
    );

    expect(credentialService.requireActiveAccess).toHaveBeenCalledWith(
      'user-1',
      'credential-1',
    );

    expect(prisma.mcDonaldsOrder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_credentialId_externalOrderId: {
            userId: 'user-1',
            credentialId: 'credential-1',
            externalOrderId: 'external-1',
          },
        },
      }),
    );
    expect(prisma.mcDonaldsOrder.upsert.mock.calls[0]?.[0].create).toEqual(
      expect.objectContaining({
        paymentUrlCiphertext: expect.any(String),
      }),
    );
  });

  it('下单响应不能识别官方订单号时不创建本地订单', async () => {
    const prisma = createPrismaMock();
    const { service } = createService(prisma);
    const rawTool = createRawCreateOrderTool({
      data: { accepted: true, payH5Url: 'https://pay.example/session' },
    });

    await runWithMcDonaldsOrderContext(
      'task-1',
      'user-1',
      async () => {
        await expect(
          service
            .wrapAgentTool(rawTool, {
              mcpServer: 'mcdonalds',
              mcpTool: 'create-order',
            })
            .invoke({ storeCode: 'store-1' }),
        ).resolves.toContain('未识别');
      },
      undefined,
      { mcdonaldsCredentialId: 'credential-1' },
    );

    expect(prisma.mcDonaldsOrder.upsert).not.toHaveBeenCalled();
  });

  it('下单时采用官方返回的较早支付链接到期时间', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-13T01:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.mcDonaldsOrder.upsert.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'external-1',
        status: 'UNPAID',
        totalAmount: null,
        currency: 'CNY',
      });
      const { service } = createService(prisma);
      const rawTool = createRawCreateOrderTool({
        data: {
          orderId: 'external-1',
          payH5Url: 'https://pay.example/session',
          payH5UrlExpiresAt: '2026-08-13T01:10:00.000Z',
          status: 'UNPAID',
        },
      });

      await runWithMcDonaldsOrderContext(
        'task-1',
        'user-1',
        async () => {
          await service
            .wrapAgentTool(rawTool, {
              mcpServer: 'mcdonalds',
              mcpTool: 'create-order',
            })
            .invoke({ storeCode: 'store-1' });
        },
        undefined,
        { mcdonaldsCredentialId: 'credential-1' },
      );

      expect(prisma.mcDonaldsOrder.upsert.mock.calls[0]?.[0].create).toEqual(
        expect.objectContaining({
          paymentUrlExpiresAt: new Date('2026-08-13T01:10:00.000Z'),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('下单时保留官方已过期的支付链接到期时间', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-13T01:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.mcDonaldsOrder.upsert.mockResolvedValue({
        id: 'order-1',
        externalOrderId: 'external-1',
        status: 'UNPAID',
        totalAmount: null,
        currency: 'CNY',
      });
      const { service } = createService(prisma);
      const rawTool = createRawCreateOrderTool({
        data: {
          orderId: 'external-1',
          payH5Url: 'https://pay.example/session',
          payH5UrlExpiresAt: '2026-08-13T00:50:00.000Z',
          status: 'UNPAID',
        },
      });

      await runWithMcDonaldsOrderContext(
        'task-1',
        'user-1',
        async () => {
          await service
            .wrapAgentTool(rawTool, {
              mcpServer: 'mcdonalds',
              mcpTool: 'create-order',
            })
            .invoke({ storeCode: 'store-1' });
        },
        undefined,
        { mcdonaldsCredentialId: 'credential-1' },
      );

      expect(prisma.mcDonaldsOrder.upsert.mock.calls[0]?.[0].create).toEqual(
        expect.objectContaining({
          paymentUrlExpiresAt: new Date('2026-08-13T00:50:00.000Z'),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('手动刷新仅调用审核后的 query-order，并写入订单刷新审计', async () => {
    const prisma = createPrismaMock();
    const existingOrder = {
      id: 'order-1',
      userId: 'user-1',
      externalOrderId: 'external-1',
      status: 'UNPAID',
      statusLabel: null,
      storeName: '上海人民广场店',
      fulfillmentType: null,
      totalAmount: { toString: () => '24.50' },
      discountAmount: null,
      currency: 'CNY',
      items: [],
      estimatedFulfillmentAt: null,
      lastRefreshedAt: null,
      createdAt: new Date('2026-08-12T10:00:00.000Z'),
      credentialId: 'credential-1',
      paymentUrlCiphertext: null,
      paymentUrlExpiresAt: null,
    };
    prisma.mcDonaldsOrder.findFirst.mockResolvedValue(existingOrder);
    prisma.mcDonaldsOrder.update.mockResolvedValue({
      ...existingOrder,
      status: 'PAID',
      lastRefreshedAt: new Date('2026-08-12T10:05:00.000Z'),
    });
    const manager = createMcpClientManagerMock();
    manager.getMcDonaldsToolByName.mockResolvedValue({
      invoke: jest
        .fn()
        .mockResolvedValue(
          JSON.stringify({ data: { orderId: 'external-1', status: 'PAID' } }),
        ),
    });
    const { service, credentialService } = createService(prisma, manager);

    const result = await service.refresh('order-1', 'user-1');

    expect(credentialService.requireActiveAccess).toHaveBeenCalledWith(
      'user-1',
      'credential-1',
    );
    expect(manager.getMcDonaldsToolByName).toHaveBeenCalledWith(
      'credential-1',
      'token-1',
      'query-order',
    );
    expect(manager.getMcDonaldsToolByName).toHaveBeenCalledTimes(1);
    const queryOrderTool =
      await manager.getMcDonaldsToolByName.mock.results[0]?.value;
    expect(queryOrderTool.invoke).toHaveBeenCalledWith({
      orderId: 'external-1',
    });
    expect(prisma.mcDonaldsOrderRefresh.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCESS',
          orderId: 'order-1',
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({ status: 'PAID' }));
  });

  it('批量读取 SSE 卡片时从查询层排除支付密文和原始快照', async () => {
    const prisma = createPrismaMock();
    const manager = createMcpClientManagerMock();
    prisma.mcDonaldsOrder.findMany.mockResolvedValue([]);
    const { service } = createService(prisma, manager);

    await service.getCardsByIds(['order-1'], 'user-1');

    expect(prisma.mcDonaldsOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['order-1'] }, userId: 'user-1' },
        select: expect.not.objectContaining({
          paymentUrlCiphertext: true,
          rawSnapshot: true,
        }),
      }),
    );
  });

  it('仅使用授权的短期支付链接在内存中编码 PNG 二维码', async () => {
    const prisma = createPrismaMock();
    const crypto = new PaymentUrlCryptoService(
      new ConfigService({
        MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString(
          'base64',
        ),
      }),
    );
    prisma.mcDonaldsOrder.findFirst.mockResolvedValue({
      id: 'order-1',
      userId: 'user-1',
      credentialId: 'credential-1',
      status: 'UNPAID',
      paymentUrlCiphertext: crypto.encrypt('https://pay.example/session'),
      paymentUrlExpiresAt: new Date(Date.now() + 60_000),
    });
    const credentialService = createCredentialServiceMock();
    const service = new McDonaldsOrderService(
      prisma as never,
      crypto,
      createMcpClientManagerMock() as never,
      credentialService as never,
    );

    const png = await service.getPaymentQr('order-1', 'user-1');

    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(credentialService.requireActiveAccess).toHaveBeenCalledWith(
      'user-1',
      'credential-1',
    );
    // scrypt 密钥派生与 PNG 二维码编码都是 CPU 密集操作，本用例单独运行约 2s；
    // 全量并行时 worker 争抢 CPU 会突破 Jest 默认的 5s 上限，因此显式放宽。
  }, 20_000);

  it('下单工具执行前会再次确认任务锁定的凭据仍然有效', async () => {
    const prisma = createPrismaMock();
    prisma.mcDonaldsOrder.upsert.mockResolvedValue({
      id: 'order-1',
      externalOrderId: 'external-1',
      status: 'UNPAID',
      totalAmount: null,
      currency: 'CNY',
    });
    const { service, credentialService } = createService(prisma);
    const rawTool = createRawCreateOrderTool({
      data: { orderId: 'external-1', status: 'UNPAID' },
    });

    await runWithMcDonaldsOrderContext(
      'task-1',
      'user-1',
      async () => {
        await service
          .wrapAgentTool(rawTool, {
            mcpServer: 'mcdonalds',
            mcpTool: 'create-order',
          })
          .invoke({ storeCode: 'store-1' });
      },
      undefined,
      { mcdonaldsCredentialId: 'credential-1' },
    );

    expect(credentialService.requireActiveAccess).toHaveBeenCalledWith(
      'user-1',
      'credential-1',
    );
  });
});
