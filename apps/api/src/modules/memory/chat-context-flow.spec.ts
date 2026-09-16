import { Test } from '@nestjs/testing';
import { MessageRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import { ChatContextService } from './chat-context.service';
import {
  ConversationSummaryService,
  type ConversationSummaryValue,
} from './conversation-summary.service';
import { LlmService } from '../llm/llm.service';
import { estimateContextTokens } from './context-budget';

describe('Flow 会话上下文', () => {
  it('预算充足时保留超过 12 条的历史，并排除任务创建后的消息', async () => {
    const history = Array.from({ length: 41 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? MessageRole.ASSISTANT : MessageRole.USER,
      content: index === 0 ? '主角叫林舟，不能改变姓名' : `短消息 ${index}`,
      agentId: null,
      modelContext: null,
    }));
    const future = { ...history[0], id: 'future', content: '下一轮的新要求' };
    const prisma = {
      streamTask: {
        findFirst: jest.fn().mockResolvedValue({
          contextMessageIds: history.map((message) => message.id),
        }),
      },
      message: {
        findMany: jest.fn((args: Prisma.MessageFindManyArgs) => {
          const ids = args.where?.id;
          const included =
            typeof ids === 'object' && Array.isArray(ids.in)
              ? ids.in
              : undefined;
          const selected = included
            ? history.filter((message) => included.includes(message.id))
            : [...history, future];
          return Promise.resolve(
            args.take ? selected.slice(-args.take).reverse() : selected,
          );
        }),
      },
      conversation: { findUnique: jest.fn().mockResolvedValue(null) },
      agent: { findMany: jest.fn(), findFirst: jest.fn() },
    };
    const summary = {
      getConversationSummary: jest.fn().mockResolvedValue(null),
    };
    const module = await Test.createTestingModule({
      providers: [
        ChatContextService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConversationSummaryService, useValue: summary },
        {
          provide: LlmModelRegistryService,
          useValue: {
            getContextLimits: jest.fn().mockReturnValue({
              contextWindowTokens: 100000,
              maxOutputTokens: 10000,
              modelPreset: 'test-model',
            }),
          },
        },
      ],
    }).compile();
    const bundle = await module
      .get(ChatContextService)
      .buildContextBundle('conversation', 'pending');
    expect(bundle.messages).toHaveLength(41);
    expect(bundle.messages[0].content).toContain('主角叫林舟');
    expect(
      bundle.messages.some((message) => message.content.includes('下一轮')),
    ).toBe(false);
  });
});

/** 用真实上下文和摘要服务验证调用前压缩及跨节点复用。 */
async function createLongContext(contentLength = 300, count = 41) {
  const history = Array.from({ length: count }, (_, index) => ({
    id: `long-${index}`,
    role: index % 2 ? MessageRole.ASSISTANT : MessageRole.USER,
    content:
      index === count - 1
        ? '请按之前的约束续写第二章'
        : `第${index}条：` + '设定'.repeat(contentLength),
    agentId: null,
    modelContext: null,
  }));
  let saved: (ConversationSummaryValue & { updatedAt: Date }) | null = null;
  const prisma = {
    streamTask: {
      findFirst: jest.fn().mockResolvedValue({
        contextMessageIds: history.map((message) => message.id),
      }),
    },
    message: { findMany: jest.fn().mockResolvedValue(history) },
    conversation: { findUnique: jest.fn().mockResolvedValue(null) },
    agent: { findMany: jest.fn(), findFirst: jest.fn() },
    conversationSummary: {
      findUnique: jest.fn(() => Promise.resolve(saved)),
      upsert: jest.fn(({ create }: { create: ConversationSummaryValue }) => {
        saved ??= { ...create, updatedAt: new Date(0) };
        return Promise.resolve(saved);
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const llm = {
    generateChatText: jest
      .fn()
      .mockResolvedValue('林舟不能离开潜艇；继续创作第二章，保持既定世界观。'),
  };
  const registry = {
    getContextLimits: (modelPreset = 'small') => ({
      modelPreset,
      contextWindowTokens: modelPreset === 'large' ? 200000 : 16000,
      maxOutputTokens: 2000,
    }),
  };
  const module = await Test.createTestingModule({
    providers: [
      ChatContextService,
      ConversationSummaryService,
      { provide: PrismaService, useValue: prisma },
      { provide: LlmService, useValue: llm },
      { provide: LlmModelRegistryService, useValue: registry },
    ],
  }).compile();
  return { service: module.get(ChatContextService), history, llm, prisma };
}

describe('按模型预算压缩', () => {
  it('长历史调用前生成摘要，同一任务下一节点直接复用，扩大模型容量后可重新使用原文', async () => {
    const { service, history, llm } = await createLongContext();
    const first = await service.buildContextBundle('c', 'pending', null, {
      modelPreset: 'small',
    });
    expect(first.summary?.content).toContain('林舟不能离开潜艇');
    expect(first.messages.at(-1)?.content).toBe(history.at(-1)?.content);
    expect(estimateContextTokens(first.messages)).toBeLessThanOrEqual(13200);
    const calls = llm.generateChatText.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const second = await service.buildContextBundle('c', 'pending', null, {
      modelPreset: 'small',
    });
    expect(llm.generateChatText).toHaveBeenCalledTimes(calls);
    expect(second.messages).toEqual(first.messages);
    const large = await service.buildContextBundle('c', 'pending', null, {
      modelPreset: 'large',
    });
    expect(large.summary).toBeUndefined();
    expect(large.messages).toHaveLength(history.length);
    expect(large.messages[0].content).toBe(history[0].content);
    expect(llm.generateChatText).toHaveBeenCalledTimes(calls);
  });

  it('本轮输入过大时明确报错，不截断用户内容或伪造摘要', async () => {
    const { service, history, llm } = await createLongContext(1, 1);
    history[0].content = '本轮必须保留的长正文'.repeat(3000);
    await expect(service.buildContextBundle('c', 'pending')).rejects.toThrow(
      '本轮输入超过',
    );
    expect(llm.generateChatText).not.toHaveBeenCalled();
  });

  it('历史快照缺失时不回退到最新消息，防止读取下一轮输入', async () => {
    const { service, prisma, llm } = await createLongContext();
    prisma.streamTask.findFirst.mockResolvedValue({ contextMessageIds: [] });
    await expect(service.buildContextBundle('c', 'pending')).rejects.toThrow(
      '缺少会话历史快照',
    );
    expect(llm.generateChatText).not.toHaveBeenCalled();
  });

  it('固定提示词和工具预算过大时阻止调用', async () => {
    const { service, llm } = await createLongContext(1);
    await expect(
      service.buildContextBundle('c', 'pending', null, {
        reservedTokens: 15000,
      }),
    ).rejects.toThrow('已占满模型上下文');
    expect(llm.generateChatText).not.toHaveBeenCalled();
  });
});
