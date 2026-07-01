import { MessageRole } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConversationSummaryService } from './conversation-summary.service';
import {
  CHAT_CONTEXT_RECENT_MESSAGE_LIMIT,
  CONVERSATION_SUMMARY_MAX_OUTPUT_TOKENS,
  CONVERSATION_SUMMARY_MIN_SOURCE_MESSAGE_COUNT,
  CONVERSATION_SUMMARY_TEMPERATURE,
} from './memory.constants';

type MessageRecord = {
  id: string;
  role: MessageRole;
  content: string;
};

/**
 * 创建测试消息列表
 * @param count 需要创建的消息数量
 * @returns 返回按用户和助手角色交替排列的测试消息列表
 * @description 用于构造超过最近窗口的会话历史，验证摘要来源消息的阈值和增量切片规则。
 */
const createMessages = (count: number): MessageRecord[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? MessageRole.USER : MessageRole.ASSISTANT,
    content: `消息内容 ${index + 1}`,
  }));

describe('ConversationSummaryService', () => {
  /**
   * 创建会话摘要服务测试实例
   * @returns 返回服务实例以及 Prisma、LLM 的 mock 对象
   * @description 为每个用例提供隔离的依赖注入对象，避免测试之间共享 mock 调用状态。
   */
  const createService = () => {
    const prisma = {
      message: {
        findMany: jest.fn(),
      },
      conversationSummary: {
        findUnique: jest.fn(),
        deleteMany: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const llmService = {
      generateChatText: jest.fn(),
    };

    return {
      service: new ConversationSummaryService(
        prisma as unknown as PrismaService,
        llmService as unknown as LlmService,
      ),
      prisma,
      llmService,
    };
  };

  it('历史消息不足摘要阈值时会清理旧摘要并返回 null', async () => {
    const { service, prisma, llmService } = createService();
    const messageCount =
      CHAT_CONTEXT_RECENT_MESSAGE_LIMIT +
      CONVERSATION_SUMMARY_MIN_SOURCE_MESSAGE_COUNT -
      1;

    prisma.message.findMany.mockResolvedValue(createMessages(messageCount));
    prisma.conversationSummary.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      service.refreshConversationSummary('conversation-1'),
    ).resolves.toBeNull();
    expect(prisma.conversationSummary.deleteMany).toHaveBeenCalledWith({
      where: { conversationId: 'conversation-1' },
    });
    expect(llmService.generateChatText).not.toHaveBeenCalled();
  });

  it('没有可复用摘要时会使用非流式生成全量摘要并保存', async () => {
    const { service, prisma, llmService } = createService();
    const sourceMessageCount = CONVERSATION_SUMMARY_MIN_SOURCE_MESSAGE_COUNT;
    const messageCount = CHAT_CONTEXT_RECENT_MESSAGE_LIMIT + sourceMessageCount;
    const summaryRecord = {
      id: 'summary-1',
      conversationId: 'conversation-1',
      summary: '新的摘要',
      latestMessageId: `message-${sourceMessageCount}`,
      messageCount: sourceMessageCount,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    prisma.message.findMany.mockResolvedValue(createMessages(messageCount));
    prisma.conversationSummary.findUnique.mockResolvedValue(null);
    prisma.conversationSummary.upsert.mockResolvedValue(summaryRecord);
    llmService.generateChatText.mockResolvedValue('新的摘要');

    await expect(
      service.refreshConversationSummary('conversation-1'),
    ).resolves.toEqual(summaryRecord);
    expect(llmService.generateChatText).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ]),
      {
        generation: {
          temperature: CONVERSATION_SUMMARY_TEMPERATURE,
          maxOutputTokens: CONVERSATION_SUMMARY_MAX_OUTPUT_TOKENS,
        },
      },
    );
    expect(prisma.conversationSummary.upsert).toHaveBeenCalledWith({
      where: { conversationId: 'conversation-1' },
      create: {
        conversationId: 'conversation-1',
        summary: '新的摘要',
        latestMessageId: `message-${sourceMessageCount}`,
        messageCount: sourceMessageCount,
      },
      update: {
        summary: '新的摘要',
        latestMessageId: `message-${sourceMessageCount}`,
        messageCount: sourceMessageCount,
      },
    });
  });

  it('已有摘要落后时会只把新增历史消息交给增量摘要', async () => {
    const { service, prisma, llmService } = createService();
    const sourceMessageCount =
      CONVERSATION_SUMMARY_MIN_SOURCE_MESSAGE_COUNT + 1;
    const messageCount = CHAT_CONTEXT_RECENT_MESSAGE_LIMIT + sourceMessageCount;

    prisma.message.findMany.mockResolvedValue(createMessages(messageCount));
    prisma.conversationSummary.findUnique.mockResolvedValue({
      id: 'summary-1',
      conversationId: 'conversation-1',
      summary: '旧摘要',
      latestMessageId: 'message-2',
      messageCount: 2,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    prisma.conversationSummary.upsert.mockResolvedValue({
      id: 'summary-1',
      conversationId: 'conversation-1',
      summary: '更新后的摘要',
      latestMessageId: `message-${sourceMessageCount}`,
      messageCount: sourceMessageCount,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    llmService.generateChatText.mockResolvedValue('更新后的摘要');

    await service.refreshConversationSummary('conversation-1');

    const [messages] = llmService.generateChatText.mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    const userPrompt = messages[1]?.content ?? '';

    expect(userPrompt).toContain('已有摘要：\n旧摘要');
    expect(userPrompt).not.toContain('消息内容 1');
    expect(userPrompt).not.toContain('消息内容 2');
    expect(userPrompt).toContain('消息内容 3');
    expect(userPrompt).toContain(`消息内容 ${sourceMessageCount}`);
  });
});
