import type { PrismaService } from '../../prisma/prisma.service';
import type { LlmService } from '../llm/llm.service';
import { GroupRouterService } from './group-router.service';

describe('GroupRouterService', () => {
  /**
   * 创建群路由器测试实例
   * @returns 返回服务与 prisma、LLM mock
   * @description 验证结构化路由解析、非法输出与异常时的回退行为。
   */
  const createService = () => {
    const prisma = { agent: { findMany: jest.fn() } };
    const llmService = { generateChatText: jest.fn() };
    return {
      service: new GroupRouterService(
        prisma as unknown as PrismaService,
        llmService as unknown as LlmService,
      ),
      prisma,
      llmService,
    };
  };

  const members = [
    {
      id: 'agent-general',
      name: '通用助手',
      description: '全能对话',
      toolGroups: ['default'],
      isDefault: true,
    },
    {
      id: 'agent-painter',
      name: '画师',
      description: '文生图',
      toolGroups: ['image-gen'],
      isDefault: false,
    },
  ];

  it('按模型结构化输出选中成员并透出理由', async () => {
    const { service, prisma, llmService } = createService();
    prisma.agent.findMany.mockResolvedValue(members);
    llmService.generateChatText.mockResolvedValue(
      '{"agentId":"agent-painter","reason":"用户要画图"}',
    );

    const result = await service.route('帮我画一只太空熊', [
      'agent-general',
      'agent-painter',
    ]);

    expect(result).toEqual({ agentId: 'agent-painter', reason: '用户要画图' });
  });

  it('成员唯一时短路，不调用模型', async () => {
    const { service, llmService } = createService();
    const result = await service.route('随便聊聊', ['agent-general']);
    expect(result.agentId).toBe('agent-general');
    expect(llmService.generateChatText).not.toHaveBeenCalled();
  });

  it('模型输出不合法（含幻觉成员 id）时回退第一个成员', async () => {
    const { service, prisma, llmService } = createService();
    prisma.agent.findMany.mockResolvedValue(members);
    llmService.generateChatText.mockResolvedValue(
      '{"agentId":"agent-ghost","reason":"?"}',
    );

    const result = await service.route('画图', [
      'agent-general',
      'agent-painter',
    ]);
    expect(result.agentId).toBe('agent-general');
  });

  it('模型异常时回退第一个成员，不阻塞发送链路', async () => {
    const { service, prisma, llmService } = createService();
    prisma.agent.findMany.mockResolvedValue(members);
    llmService.generateChatText.mockRejectedValue(new Error('llm down'));

    const result = await service.route('画图', [
      'agent-general',
      'agent-painter',
    ]);
    expect(result.agentId).toBe('agent-general');
  });
});
