import { Test } from '@nestjs/testing';
import { MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import {
  ConversationSummaryService,
  summarySourceDigest,
  type SummarySourceMessage,
} from './conversation-summary.service';
import { estimateContextTokens } from './context-budget';

/** 构造有序消息，用于校验摘要覆盖范围。 */
function messages(count: number): SummarySourceMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? MessageRole.ASSISTANT : MessageRole.USER,
    content: `原始内容-${index}`,
    agentId: null,
  }));
}

/** 装配真实摘要服务，数据库和模型作为可控边界。 */
async function setup() {
  const prisma = {
    conversationSummary: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const llm = {
    generateChatText: jest
      .fn<
        ReturnType<LlmService['generateChatText']>,
        Parameters<LlmService['generateChatText']>
      >()
      .mockResolvedValue('主角林舟留在潜艇内，下一步完成第二章。'),
  };
  const module = await Test.createTestingModule({
    providers: [
      ConversationSummaryService,
      { provide: PrismaService, useValue: prisma },
      { provide: LlmService, useValue: llm },
      {
        provide: LlmModelRegistryService,
        useValue: {
          getContextLimits: () => ({
            modelPreset: 'summary-model',
            contextWindowTokens: 16000,
            maxOutputTokens: 2000,
          }),
        },
      },
    ],
  }).compile();
  return { service: module.get(ConversationSummaryService), prisma, llm };
}

describe('ConversationSummaryService', () => {
  it('没有压缩来源时不调用模型，也不清除已有摘要', async () => {
    const { service, prisma, llm } = await setup();
    expect(await service.refreshConversationSummary('c', [])).toBeNull();
    expect(llm.generateChatText).not.toHaveBeenCalled();
    expect(prisma.conversationSummary.upsert).not.toHaveBeenCalled();
  });

  it('覆盖超过 80 条的全部来源，并批量摘要而非每条调用模型', async () => {
    const { service, llm } = await setup();
    const source = messages(120);
    const value = await service.refreshConversationSummary('c', source, {
      maxOutputTokens: 1000,
    });
    const prompts = llm.generateChatText.mock.calls
      .flatMap(([input]) => input.map((message) => message.content))
      .join('\n');
    expect(prompts).toContain('原始内容-0');
    expect(prompts).toContain('原始内容-119');
    expect(llm.generateChatText.mock.calls.length).toBeLessThan(5);
    expect(value?.messageCount).toBe(120);
    expect(value?.sourceDigest).toBe(summarySourceDigest(source));
  });

  it('只在验证过的前缀基础上增量合并新历史', async () => {
    const { service, prisma, llm } = await setup();
    const source = messages(6);
    prisma.conversationSummary.findUnique.mockResolvedValue({
      summary: '旧摘要',
      messageCount: 2,
      latestMessageId: source[1].id,
      sourceDigest: summarySourceDigest(source.slice(0, 2)),
      updatedAt: new Date(0),
    });
    await service.refreshConversationSummary('c', source, {
      maxOutputTokens: 1000,
    });
    const prompt = llm.generateChatText.mock.calls[0][0][1].content;
    expect(prompt).toContain('旧摘要');
    expect(prompt).toContain('原始内容-2');
    expect(prompt).not.toContain('原始内容-0');
    expect(prisma.conversationSummary.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId: 'c',
          updatedAt: new Date(0),
          sourceDigest: summarySourceDigest(source.slice(0, 2)),
        },
      }),
    );
  });

  it('同一来源摘要复用，不重复调用模型', async () => {
    const { service, prisma, llm } = await setup();
    const source = messages(4);
    prisma.conversationSummary.findUnique.mockResolvedValue({
      summary: '已有摘要',
      messageCount: 4,
      latestMessageId: source[3].id,
      sourceDigest: summarySourceDigest(source),
      updatedAt: new Date(0),
    });
    expect(
      (await service.refreshConversationSummary('c', source))?.summary,
    ).toBe('已有摘要');
    expect(llm.generateChatText).not.toHaveBeenCalled();
  });

  it('旧任务不能使用或覆盖包含未来消息的新摘要', async () => {
    const { service, prisma, llm } = await setup();
    const source = messages(6);
    prisma.conversationSummary.findUnique.mockResolvedValue({
      summary: '未来一轮的秘密',
      messageCount: 6,
      latestMessageId: source[5].id,
      sourceDigest: summarySourceDigest(source),
      updatedAt: new Date(0),
    });
    const value = await service.refreshConversationSummary(
      'c',
      source.slice(0, 2),
    );
    expect(value?.messageCount).toBe(2);
    expect(llm.generateChatText.mock.calls[0][0][1].content).not.toContain(
      '未来一轮',
    );
    expect(prisma.conversationSummary.updateMany).not.toHaveBeenCalled();
  });

  it('单条超长旧消息分块处理，摘要请求本身不超过预算', async () => {
    const { service, llm } = await setup();
    const source = [
      {
        ...messages(1)[0],
        content: '开头设定' + '长章节内容'.repeat(4000) + '结尾事实',
      },
    ];
    const onModelCall = jest.fn();
    await service.refreshConversationSummary('c', source, {
      maxOutputTokens: 1000,
      onModelCall,
    });
    expect(llm.generateChatText.mock.calls.length).toBeGreaterThan(1);
    expect(onModelCall).toHaveBeenCalledTimes(
      llm.generateChatText.mock.calls.length,
    );
    for (const [input] of llm.generateChatText.mock.calls)
      expect(estimateContextTokens(input)).toBeLessThanOrEqual(10500);
    expect(llm.generateChatText.mock.calls.at(-1)?.[0][1].content).toContain(
      '结尾事实',
    );
  });

  it('空摘要明确失败，原有摘要和消息不被覆盖', async () => {
    const { service, prisma, llm } = await setup();
    llm.generateChatText.mockResolvedValue('');
    await expect(
      service.refreshConversationSummary('c', messages(2)),
    ).rejects.toThrow('空内容');
    expect(prisma.conversationSummary.upsert).not.toHaveBeenCalled();
  });
});
