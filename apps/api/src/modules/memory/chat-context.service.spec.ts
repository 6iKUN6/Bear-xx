import { ConversationType, MessageRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatContextService } from './chat-context.service';
import { ConversationSummaryService } from './conversation-summary.service';
import { CHAT_CONTEXT_RECENT_MESSAGE_LIMIT } from './memory.constants';
import { createFlowDefinitionPreset } from '../agent-flow/definition/flow-definition.templates';

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
      agent: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      conversation: {
        // 缺省返回 null = 旧数据（无会话形态），走「历史里有别人发言」的兜底判定
        findUnique: jest.fn().mockResolvedValue(null),
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
        agentId: null,
      },
      {
        role: MessageRole.USER,
        content: '用户问题',
        agentId: null,
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
        agentId: true,
        modelContext: true,
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

  it('群会话：其它智能体的发言转写为署名记录，自己的保持 assistant', async () => {
    const { service, prisma, conversationSummaryService } = createService();
    conversationSummaryService.getConversationSummary.mockResolvedValue(null);
    prisma.message.findMany.mockResolvedValue([
      // findMany 按 createdAt desc 返回，service 内部会 reverse
      {
        role: MessageRole.ASSISTANT,
        content: '我是B的回答',
        agentId: 'agent-b',
        modelContext: { version: 1, marker: 'self' },
      },
      {
        role: MessageRole.ASSISTANT,
        content: '深圳今天晴',
        agentId: 'agent-a',
        modelContext: { version: 1, marker: 'foreign' },
      },
      { role: MessageRole.USER, content: '@天气专家 深圳天气?', agentId: null },
    ]);
    prisma.agent.findMany.mockResolvedValue([
      { id: 'agent-a', name: '天气专家' },
    ]);

    const bundle = await service.buildContextBundle(
      'conversation-1',
      'pending-message',
      'agent-b',
    );

    // 首条为群聊语境 system 说明
    expect(bundle.messages[0]?.role).toBe('system');
    expect(bundle.messages[0]?.content).toContain('多助手协作对话');
    expect(bundle.messages.slice(1)).toEqual([
      { role: 'user', content: '@天气专家 深圳天气?' },
      { role: 'user', content: '[助手·天气专家]: 深圳今天晴' },
      {
        role: 'assistant',
        content: '我是B的回答',
        modelContext: { version: 1, marker: 'self' },
      },
    ]);
  });

  it('单助手会话（含 agentId 全为 null 的历史）不做任何转写，零回归', async () => {
    const { service, prisma, conversationSummaryService } = createService();
    conversationSummaryService.getConversationSummary.mockResolvedValue(null);
    prisma.message.findMany.mockResolvedValue([
      { role: MessageRole.ASSISTANT, content: '回复', agentId: null },
      { role: MessageRole.USER, content: '问题', agentId: null },
    ]);

    const bundle = await service.buildContextBundle(
      'conversation-1',
      'pending-message',
      null,
    );

    expect(bundle.messages).toEqual([
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回复' },
    ]);
    expect(prisma.agent.findMany).not.toHaveBeenCalled();
  });

  it('群聊首条消息（历史无其它发言）也注入身份说明，含自己与其它成员的能力', async () => {
    const { service, prisma, conversationSummaryService } = createService();
    conversationSummaryService.getConversationSummary.mockResolvedValue(null);
    // 群里第一句话：历史只有用户这一条，没有任何 assistant 发言
    prisma.message.findMany.mockResolvedValue([
      { role: MessageRole.USER, content: '你俩有人会画画吗', agentId: null },
    ]);
    prisma.conversation.findUnique.mockResolvedValue({
      type: ConversationType.GROUP,
      agentIds: ['agent-painter', 'agent-general'],
    });
    prisma.agent.findMany.mockResolvedValue([
      {
        id: 'agent-painter',
        name: '画师一号',
        description: '文生图',
        ...boundFlowWith(['image-gen']),
      },
      {
        id: 'agent-general',
        name: '通用助手',
        description: '',
        ...boundFlowWith(['default']),
      },
    ]);

    const bundle = await service.buildContextBundle(
      'conversation-1',
      'pending-message',
      'agent-painter',
    );

    const system = bundle.messages[0];
    expect(system?.role).toBe('system');
    // 知道自己是谁 + 专长（缺了这段就会出现「我就是画师一号」的冒充）
    expect(system?.content).toContain('你是「画师一号」');
    expect(system?.content).toContain('画图 / 生成图片 / 修改图片');
    // 知道群里还有谁
    expect(system?.content).toContain('通用助手');
    expect(system?.content).toContain('绝不要自称是群里的其它成员');
  });

  it('单聊会话不注入群聊身份说明', async () => {
    const { service, prisma, conversationSummaryService } = createService();
    conversationSummaryService.getConversationSummary.mockResolvedValue(null);
    prisma.message.findMany.mockResolvedValue([
      { role: MessageRole.USER, content: '你好', agentId: null },
    ]);
    prisma.conversation.findUnique.mockResolvedValue({
      type: ConversationType.SINGLE,
      agentIds: ['agent-painter'],
    });

    const bundle = await service.buildContextBundle(
      'conversation-1',
      'pending-message',
      'agent-painter',
    );

    expect(bundle.messages).toEqual([{ role: 'user', content: '你好' }]);
  });

  it('历史默认助手（null）发言在具体智能体回答时按默认智能体名转写', async () => {
    const { service, prisma, conversationSummaryService } = createService();
    conversationSummaryService.getConversationSummary.mockResolvedValue(null);
    prisma.message.findMany.mockResolvedValue([
      { role: MessageRole.ASSISTANT, content: '通用回答', agentId: null },
      { role: MessageRole.USER, content: '问题', agentId: null },
    ]);
    prisma.agent.findFirst.mockResolvedValue({ name: '通用助手' });

    const bundle = await service.buildContextBundle(
      'conversation-1',
      'pending-message',
      'agent-x',
    );

    expect(bundle.messages.slice(1)).toEqual([
      { role: 'user', content: '问题' },
      { role: 'user', content: '[助手·通用助手]: 通用回答' },
    ]);
  });
});

/**
 * 构造一个「绑定了含指定工具组的 Flow」的成员
 * @param toolGroups 该成员 agent 节点上声明的工具组
 * @returns 返回可交给 prisma 替身的绑定投影
 * @description 能力标签已改为从绑定 Flow 的图上推导，替身必须给出真实 Definition 而不是
 * 一个 toolGroups 数组——否则测的就不是现在的链路。以 react 预设为底改工具组，保证图合法。
 */
function boundFlowWith(toolGroups: string[]) {
  const preset = createFlowDefinitionPreset('react');
  return {
    defaultFlowVersion: {
      definition: {
        ...preset,
        nodes: preset.nodes.map((node) =>
          node.type === 'agent'
            ? { ...node, config: { ...node.config, toolGroups } }
            : node,
        ),
      },
    },
  };
}
