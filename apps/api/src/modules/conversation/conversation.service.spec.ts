import { BadRequestException } from '@nestjs/common';
import { ConversationType } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { ConversationService } from './conversation.service';

describe('ConversationService（单聊/群聊）', () => {
  /**
   * 创建会话服务测试实例
   * @returns 返回服务与 prisma mock
   * @description 覆盖单聊幂等复用、建群约束与成员增删的边界行为。
   */
  const createService = () => {
    const prisma = {
      conversation: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      agent: { findMany: jest.fn() },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          membershipTier: 'FREE',
          membershipExpiresAt: null,
        }),
      },
      mcDonaldsOrder: { findMany: jest.fn() },
    };
    return {
      service: new ConversationService(
        prisma as unknown as PrismaService,
        {
          toOrderCard: jest.fn((order) => ({
            ...order,
            totalAmount: order.totalAmount?.toString() ?? null,
            discountAmount: order.discountAmount?.toString() ?? null,
            estimatedFulfillmentAt:
              order.estimatedFulfillmentAt?.toISOString() ?? null,
            lastRefreshedAt: order.lastRefreshedAt?.toISOString() ?? null,
            createdAt: order.createdAt.toISOString(),
          })),
        } as never,
        {
          evaluate: jest.fn().mockReturnValue({
            canUse: true,
            effectiveTier: 'FREE',
          }),
        } as never,
      ),
      prisma,
    };
  };

  const conversationRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'conv-1',
    title: '群聊',
    type: ConversationType.GROUP,
    agentIds: ['a1', 'a2'],
    defaultAgentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    userId: 'user-1',
    isTest: false,
    ...overrides,
  });

  it('单聊幂等：同绑定的既有会话直接复用，不重复创建', async () => {
    const { service, prisma } = createService();
    prisma.agent.findMany.mockResolvedValue([{ id: 'a1' }]);
    prisma.conversation.findFirst.mockResolvedValue(
      conversationRow({ type: ConversationType.SINGLE, agentIds: ['a1'] }),
    );

    const result = await service.create('user-1', {
      type: ConversationType.SINGLE,
      agentIds: ['a1'],
    });

    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(result.id).toBe('conv-1');
  });

  it('建群成员不足 2 个被拒绝', async () => {
    const { service } = createService();
    await expect(
      service.create('user-1', {
        type: ConversationType.GROUP,
        agentIds: ['a1'],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('建群：默认标题为成员名拼接，defaultAgentId 留空走自动路由', async () => {
    const { service, prisma } = createService();
    prisma.agent.findMany
      .mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }]) // ensureAgentsUsable
      .mockResolvedValueOnce([{ name: '通用助手' }, { name: '画师' }]); // 标题
    prisma.conversation.create.mockResolvedValue(
      conversationRow({ title: '通用助手、画师' }),
    );

    await service.create('user-1', {
      type: ConversationType.GROUP,
      agentIds: ['a1', 'a2'],
    });

    expect(prisma.conversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: ConversationType.GROUP,
        agentIds: ['a1', 'a2'],
        defaultAgentId: null,
        title: '通用助手、画师',
      }) as unknown,
    });
  });

  it('移除成员：不能移空；移除默认回答者时恢复自动路由', async () => {
    const { service, prisma } = createService();
    prisma.conversation.findFirst.mockResolvedValue(
      conversationRow({ agentIds: ['a1'], defaultAgentId: 'a1' }),
    );
    await expect(service.removeAgent('conv-1', 'user-1', 'a1')).rejects.toThrow(
      '至少保留 1 个成员',
    );

    prisma.conversation.findFirst.mockResolvedValue(
      conversationRow({ agentIds: ['a1', 'a2'], defaultAgentId: 'a2' }),
    );
    prisma.conversation.update.mockResolvedValue(
      conversationRow({ agentIds: ['a1'], defaultAgentId: null }),
    );
    await service.removeAgent('conv-1', 'user-1', 'a2');
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { agentIds: ['a1'], defaultAgentId: null },
    });
  });

  it('单聊会话不允许管理成员', async () => {
    const { service, prisma } = createService();
    prisma.conversation.findFirst.mockResolvedValue(
      conversationRow({ type: ConversationType.SINGLE, agentIds: ['a1'] }),
    );
    await expect(service.addAgent('conv-1', 'user-1', 'a2')).rejects.toThrow(
      '只有群聊可以管理成员',
    );
  });

  it('会话历史按 assistant messageId 回填安全订单卡片', async () => {
    const { service, prisma } = createService();
    prisma.conversation.findMany.mockResolvedValue([
      conversationRow({
        messages: [
          {
            id: 'message-1',
            role: 'ASSISTANT',
            content: '订单已创建',
            modelContext: { version: 1, secret: 'hidden' },
            agentId: null,
            status: 'DONE',
            createdAt: new Date('2026-08-12T10:00:00.000Z'),
            turnTraceItems: [],
          },
        ],
      }),
    ]);
    prisma.agent.findMany.mockResolvedValue([]);
    prisma.mcDonaldsOrder.findMany.mockResolvedValue([
      {
        id: 'order-1',
        messageId: 'message-1',
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
      },
    ]);

    const conversations = await service.findAllByUser('user-1');

    expect(conversations[0]?.messages[0]?.orders).toEqual([
      expect.objectContaining({ id: 'order-1', externalOrderId: 'external-1' }),
    ]);
    expect(conversations[0]?.messages[0]).not.toHaveProperty('modelContext');
    expect(prisma.mcDonaldsOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', messageId: { not: null } },
      }),
    );
  });
});
