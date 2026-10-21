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
      message: { findFirst: jest.fn(), findMany: jest.fn() },
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
        { resolveAccessUrl: jest.fn() } as never,
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

  const messageRow = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    role: 'ASSISTANT',
    content: id,
    modelContext: { version: 1, secret: 'hidden' },
    agentId: null,
    imageAsset: null,
    imageUrl: null,
    status: 'DONE',
    createdAt: new Date('2026-08-12T10:00:00.000Z'),
    turnTraceItems: [],
    streamTasks: [],
    ...overrides,
  });

  it('会话列表只返回基础信息，不加载消息', async () => {
    const { service, prisma } = createService();
    prisma.conversation.findMany.mockResolvedValue([conversationRow()]);

    const conversations = await service.findAllByUser('user-1');

    expect(prisma.conversation.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isTest: false },
      orderBy: { updatedAt: 'desc' },
    });
    expect(conversations[0]).not.toHaveProperty('messages');
    expect(conversations[0]?.id).toBe('conv-1');
  });

  it('消息分页：多取一条判断 hasMore，本页按时间正序返回', async () => {
    const { service, prisma } = createService();
    prisma.conversation.findFirst.mockResolvedValue(conversationRow());
    // 数据库按时间倒序返回 limit + 1 条
    prisma.message.findMany.mockResolvedValue([
      messageRow('m3'),
      messageRow('m2'),
      messageRow('m1'),
    ]);
    prisma.mcDonaldsOrder.findMany.mockResolvedValue([]);

    const page = await service.findMessages('conv-1', 'user-1', { limit: 2 });

    expect(page.hasMore).toBe(true);
    expect(page.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: 'conv-1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      }),
    );
    expect(page.messages[0]).not.toHaveProperty('modelContext');
  });

  it('消息分页：before 只取严格早于游标的消息，同毫秒用 id 定序', async () => {
    const { service, prisma } = createService();
    const cursorAt = new Date('2026-08-12T10:00:00.000Z');
    prisma.conversation.findFirst.mockResolvedValue(conversationRow());
    prisma.message.findFirst.mockResolvedValue({
      id: 'm5',
      createdAt: cursorAt,
    });
    prisma.message.findMany.mockResolvedValue([messageRow('m4')]);
    prisma.mcDonaldsOrder.findMany.mockResolvedValue([]);

    const page = await service.findMessages('conv-1', 'user-1', {
      before: 'm5',
      limit: 30,
    });

    expect(page.hasMore).toBe(false);
    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: { id: 'm5', conversationId: 'conv-1' },
      select: { id: true, createdAt: true },
    });
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId: 'conv-1',
          OR: [
            { createdAt: { lt: cursorAt } },
            { createdAt: cursorAt, id: { lt: 'm5' } },
          ],
        },
      }),
    );
  });

  it('消息分页：游标不属于该会话时报错，不退化为第一页', async () => {
    const { service, prisma } = createService();
    prisma.conversation.findFirst.mockResolvedValue(conversationRow());
    prisma.message.findFirst.mockResolvedValue(null);

    await expect(
      service.findMessages('conv-1', 'user-1', { before: 'other', limit: 30 }),
    ).rejects.toThrow('分页游标对应的消息不存在');
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('消息分页：非会话属主无法读取', async () => {
    const { service, prisma } = createService();
    prisma.conversation.findFirst.mockResolvedValue(null);

    await expect(
      service.findMessages('conv-1', 'intruder', { limit: 30 }),
    ).rejects.toThrow('会话不存在');
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('消息分页：回填进行中任务 ID 与本页消息的订单卡片', async () => {
    const { service, prisma } = createService();
    prisma.conversation.findFirst.mockResolvedValue(conversationRow());
    prisma.message.findMany.mockResolvedValue([
      messageRow('message-2', {
        status: 'STREAMING',
        streamTasks: [{ id: 'task-2' }],
      }),
      messageRow('message-1'),
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

    const page = await service.findMessages('conv-1', 'user-1', { limit: 30 });

    const [first, second] = page.messages;
    expect(first?.id).toBe('message-1');
    expect(first?.activeTaskId).toBeNull();
    expect(first?.orders).toEqual([
      expect.objectContaining({ id: 'order-1', externalOrderId: 'external-1' }),
    ]);
    expect(second?.activeTaskId).toBe('task-2');
    expect(prisma.mcDonaldsOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          messageId: { in: ['message-1', 'message-2'] },
        },
      }),
    );
  });
});
