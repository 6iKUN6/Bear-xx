import { MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { ConversationTitleService } from './conversation-title.service';

describe('ConversationTitleService', () => {
  /**
   * 创建会话标题服务测试实例
   * @returns 返回服务实例以及 Prisma、LLM 服务的 mock 对象
   * @description 为首轮标题生成用例提供隔离依赖，便于验证触发条件与标题清洗落库行为。
   */
  const createService = () => {
    const prisma = {
      message: {
        count: jest.fn(),
        findFirst: jest.fn(),
      },
      conversation: {
        update: jest.fn(),
      },
    };
    const llmService = {
      generateChatText: jest.fn(),
    };

    return {
      service: new ConversationTitleService(
        prisma as unknown as PrismaService,
        llmService as unknown as LlmService,
      ),
      prisma,
      llmService,
    };
  };

  it('首轮基于首条用户消息生成标题、落库并返回（含引号清洗）', async () => {
    const { service, prisma, llmService } = createService();
    prisma.message.count.mockResolvedValue(1);
    prisma.message.findFirst.mockResolvedValue({
      content: '深圳明天适合去哪玩？',
    });
    llmService.generateChatText.mockResolvedValue('“深圳出游推荐”。');

    const title = await service.generateTitleIfFirstTurn('conversation-1');

    expect(title).toBe('深圳出游推荐');
    expect(prisma.message.count).toHaveBeenCalledWith({
      where: { conversationId: 'conversation-1', role: MessageRole.USER },
    });
    const [messages] = llmService.generateChatText.mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    expect(messages[1]?.content).toContain('用户：深圳明天适合去哪玩？');
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conversation-1' },
      data: { title: '深圳出游推荐' },
    });
  });

  it('非首轮（用户消息数不为 1）直接跳过，不调用模型', async () => {
    const { service, prisma, llmService } = createService();
    prisma.message.count.mockResolvedValue(2);

    const title = await service.generateTitleIfFirstTurn('conversation-1');

    expect(title).toBeNull();
    expect(llmService.generateChatText).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('模型输出清洗后为空时不更新标题', async () => {
    const { service, prisma, llmService } = createService();
    prisma.message.count.mockResolvedValue(1);
    prisma.message.findFirst.mockResolvedValue({ content: '你好' });
    llmService.generateChatText.mockResolvedValue('“”');

    const title = await service.generateTitleIfFirstTurn('conversation-1');

    expect(title).toBeNull();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('模型调用失败时静默返回 null，保留兜底标题', async () => {
    const { service, prisma, llmService } = createService();
    prisma.message.count.mockResolvedValue(1);
    prisma.message.findFirst.mockResolvedValue({ content: '你好' });
    llmService.generateChatText.mockRejectedValue(new Error('llm down'));

    await expect(
      service.generateTitleIfFirstTurn('conversation-1'),
    ).resolves.toBeNull();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('超长标题按最大展示长度截断', async () => {
    const { service, prisma, llmService } = createService();
    prisma.message.count.mockResolvedValue(1);
    prisma.message.findFirst.mockResolvedValue({ content: '问题' });
    llmService.generateChatText.mockResolvedValue('一'.repeat(40));

    const title = await service.generateTitleIfFirstTurn('conversation-1');

    expect(title).toBe('一'.repeat(20));
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conversation-1' },
      data: { title: '一'.repeat(20) },
    });
  });
});
