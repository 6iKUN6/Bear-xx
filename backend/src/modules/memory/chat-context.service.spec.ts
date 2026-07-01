import { MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatContextService } from './chat-context.service';
import { ConversationSummaryService } from './conversation-summary.service';
import { CHAT_CONTEXT_RECENT_MESSAGE_LIMIT } from './memory.constants';

describe('ChatContextService', () => {
  /**
   * 创建聊天上下文服务测试实例
   * @returns 返回服务实例以及 Prisma、摘要服务的 mock 对象
   * @description 为上下文组装用例提供隔离的依赖对象，便于验证最近窗口查询和摘要注入行为。
   */
  const createService = () => {
    const prisma = {
      message: {
        findMany: jest.fn(),
      },
    };
    const conversationSummaryService = {
      getConversationSummary: jest.fn(),
    };

    return {
      service: new ChatContextService(
        prisma as unknown as PrismaService,
        conversationSummaryService as unknown as ConversationSummaryService,
      ),
      prisma,
      conversationSummaryService,
    };
  };

  it('会把摘要作为隐藏 system 上下文并返回最近窗口元信息', async () => {
    const { service, prisma, conversationSummaryService } = createService();

    conversationSummaryService.getConversationSummary.mockResolvedValue({
      id: 'summary-1',
      conversationId: 'conversation-1',
      summary: '用户希望先完成第一版 memory 规则。',
      latestMessageId: 'message-8',
      messageCount: 8,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    prisma.message.findMany.mockResolvedValue([
      {
        role: MessageRole.ASSISTANT,
        content: '助手回复',
      },
      {
        role: MessageRole.USER,
        content: '用户问题',
      },
    ]);

    const bundle = await service.buildContextBundle(
      'conversation-1',
      'pending-message',
    );

    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: {
        conversationId: 'conversation-1',
        id: { not: 'pending-message' },
      },
      select: {
        role: true,
        content: true,
      },
      orderBy: { createdAt: 'desc' },
      take: CHAT_CONTEXT_RECENT_MESSAGE_LIMIT,
    });
    expect(bundle.summary).toEqual({
      content: '用户希望先完成第一版 memory 规则。',
      latestMessageId: 'message-8',
      messageCount: 8,
    });
    expect(bundle.recentWindow).toEqual({
      limit: CHAT_CONTEXT_RECENT_MESSAGE_LIMIT,
      messageCount: 2,
    });
    expect(bundle.messages[0]?.role).toBe('system');
    expect(bundle.messages[0]?.content).toContain('不要向用户暴露摘要本身');
    expect(bundle.messages.slice(1)).toEqual([
      {
        role: 'user',
        content: '用户问题',
      },
      {
        role: 'assistant',
        content: '助手回复',
      },
    ]);
  });
});
