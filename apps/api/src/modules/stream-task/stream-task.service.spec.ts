import { ConfigService } from '@nestjs/config';
import { StreamTaskEventType } from '@litter-bear/types/protocol';
import { StreamTaskService } from './stream-task.service';
import { runWithMcDonaldsOrderContext } from '../mcdonalds-order/mcdonalds-order-context';

describe('StreamTaskService', () => {
  function createService() {
    const prisma = {
      streamTask: {
        update: jest.fn().mockResolvedValue({ lastEventId: 2 }),
      },
      streamTaskEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const registry = { publish: jest.fn() };
    const snapshotService = {
      appendFrame: jest
        .fn()
        .mockResolvedValue({ id: '1-0', event: 'order.created', data: '{}' }),
    };
    const mcdonaldsOrderService = {
      getCardsByIds: jest.fn().mockResolvedValue([]),
    };
    const capabilityRegistry = { getToolMetadata: jest.fn() };

    const service = new StreamTaskService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new ConfigService({ STREAM_TASK_BUFFER_TTL: 300 }),
      {} as never,
      {} as never,
      { recordStreamEvent: jest.fn() } as never,
      {} as never,
      {} as never,
      registry as never,
      snapshotService as never,
      mcdonaldsOrderService as never,
      capabilityRegistry as never,
    );

    return {
      service,
      mcdonaldsOrderService,
      snapshotService,
      capabilityRegistry,
    };
  }

  it('不会把其他 MCP 的 create-order 当作麦当劳订单创建事件', async () => {
    const { service, mcdonaldsOrderService } = createService();

    await runWithMcDonaldsOrderContext('task-1', 'user-1', async () => {
      const context =
        await import('../mcdonalds-order/mcdonalds-order-context');
      context.registerCreatedMcDonaldsOrder('order-1');
      await service['handleAgentLoopStatusEvent'](
        {
          id: 'task-1',
          userId: 'user-1',
          streamId: 'stream-1',
          conversationId: 'conversation-1',
          messageId: 'message-1',
        },
        {
          type: StreamTaskEventType.ToolCallDone,
          payload: {
            name: 'other-mcp__create-order',
            toolName: 'other-mcp__create-order',
            summary: '创建订单完成',
            index: 0,
          },
        },
      );
    });

    expect(mcdonaldsOrderService.getCardsByIds).not.toHaveBeenCalled();
  });

  it('麦当劳下单完成后只发布安全的订单卡片', async () => {
    const {
      service,
      mcdonaldsOrderService,
      snapshotService,
      capabilityRegistry,
    } = createService();
    capabilityRegistry.getToolMetadata.mockReturnValue({
      mcpServer: 'mcdonalds',
      mcpTool: 'create-order',
    });
    mcdonaldsOrderService.getCardsByIds.mockResolvedValue([
      {
        id: 'order-1',
        externalOrderId: 'external-1',
        status: 'UNPAID',
        statusLabel: '待支付',
        storeName: '人民广场店',
        fulfillmentType: '到店取餐',
        totalAmount: '24.50',
        discountAmount: null,
        currency: 'CNY',
        items: [],
        estimatedFulfillmentAt: null,
        lastRefreshedAt: null,
        createdAt: '2026-08-12T10:00:00.000Z',
      },
    ]);

    await runWithMcDonaldsOrderContext('task-1', 'user-1', async () => {
      const context =
        await import('../mcdonalds-order/mcdonalds-order-context');
      context.registerCreatedMcDonaldsOrder('order-1');
      await service['handleAgentLoopStatusEvent'](
        {
          id: 'task-1',
          userId: 'user-1',
          streamId: 'stream-1',
          conversationId: 'conversation-1',
          messageId: 'message-1',
        },
        {
          type: StreamTaskEventType.ToolCallDone,
          payload: {
            name: 'mcdonalds__create-order',
            toolName: 'mcdonalds__create-order',
            summary: '创建订单完成',
            index: 0,
          },
        },
      );
    });

    expect(mcdonaldsOrderService.getCardsByIds).toHaveBeenCalledWith(
      ['order-1'],
      'user-1',
    );
    const orderCreatedCall = snapshotService.appendFrame.mock.calls.find(
      (call) => call[1] === StreamTaskEventType.OrderCreated,
    );
    expect(orderCreatedCall).toBeDefined();
    expect(orderCreatedCall?.[2]).toEqual(
      expect.stringContaining('"order":{"id":"order-1"'),
    );
    expect(orderCreatedCall?.[2]).not.toContain('paymentUrl');
  });
});
