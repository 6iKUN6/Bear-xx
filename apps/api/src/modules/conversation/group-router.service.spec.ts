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
    // generateStructured 内部已负责「原生结构化输出 → 提示词降级」与 schema 校验，
    // 这里只 mock 它的产物：成功返回对象、不可用返回 null。
    const llmService = { generateStructured: jest.fn() };
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
    llmService.generateStructured.mockResolvedValue({
      agentId: 'agent-painter',
      reason: '用户要画图',
    });

    const result = await service.route('帮我画一只太空熊', [
      'agent-general',
      'agent-painter',
    ]);

    expect(result).toEqual({
      agentId: 'agent-painter',
      reason: '用户要画图',
      source: 'model',
    });
  });

  it('能力标签译成中文语义再喂模型（image-gen 这类技术标识语义太弱）', async () => {
    const { service, prisma, llmService } = createService();
    prisma.agent.findMany.mockResolvedValue(members);
    llmService.generateStructured.mockResolvedValue({
      agentId: 'agent-painter',
    });

    await service.route('画图', ['agent-general', 'agent-painter']);

    const [messages] = llmService.generateStructured.mock.calls[0] as unknown[];
    const userPrompt = (messages as Array<{ role: string; content: string }>)[1]
      .content;
    expect(userPrompt).toContain('画图 / 生成图片 / 修改图片');
    expect(userPrompt).toContain('通用对话');
    expect(userPrompt).not.toContain('image-gen');
  });

  it('带上最近对话与「上一轮回答者」标注，供延续类消息判断指代', async () => {
    const { service, prisma, llmService } = createService();
    prisma.agent.findMany.mockResolvedValue(members);
    llmService.generateStructured.mockResolvedValue({
      agentId: 'agent-painter',
    });

    await service.route('再来一张', ['agent-general', 'agent-painter'], {
      lastAgentId: 'agent-painter',
      recentTurns: [
        { role: 'user', content: '画只柴犬' },
        { role: 'assistant', content: '图片已生成', agentName: '画师' },
      ],
    });

    const [messages] = llmService.generateStructured.mock.calls[0] as unknown[];
    const userPrompt = (messages as Array<{ role: string; content: string }>)[1]
      .content;
    expect(userPrompt).toContain('（上一轮回答者）');
    expect(userPrompt).toContain('最近对话：');
    expect(userPrompt).toContain('画师：图片已生成');
    expect(userPrompt).toContain('用户：画只柴犬');
  });

  it('无上下文时不拼「最近对话」段（首轮消息）', async () => {
    const { service, prisma, llmService } = createService();
    prisma.agent.findMany.mockResolvedValue(members);
    llmService.generateStructured.mockResolvedValue({
      agentId: 'agent-painter',
    });

    await service.route('画图', ['agent-general', 'agent-painter']);

    const [messages] = llmService.generateStructured.mock.calls[0] as unknown[];
    const userPrompt = (messages as Array<{ role: string; content: string }>)[1]
      .content;
    expect(userPrompt).not.toContain('最近对话：');
    expect(userPrompt).not.toContain('（上一轮回答者）');
  });

  it('用 schema 约束模型输出（透传 schemaName 便于服务端定位）', async () => {
    const { service, prisma, llmService } = createService();
    prisma.agent.findMany.mockResolvedValue(members);
    llmService.generateStructured.mockResolvedValue({
      agentId: 'agent-painter',
    });

    await service.route('画图', ['agent-general', 'agent-painter']);

    const [, schema, options] = llmService.generateStructured.mock
      .calls[0] as unknown[];
    expect(schema).toBeDefined();
    expect(options).toMatchObject({ schemaName: 'group_route' });
  });

  it('成员唯一时短路，不调用模型（确定性结果，非降级）', async () => {
    const { service, llmService } = createService();
    const result = await service.route('随便聊聊', ['agent-general']);
    expect(result.agentId).toBe('agent-general');
    expect(result.source).toBe('model');
    expect(llmService.generateStructured).not.toHaveBeenCalled();
  });

  it('模型给出幻觉成员 id 时回退第一个成员并标记 fallback', async () => {
    const { service, prisma, llmService } = createService();
    prisma.agent.findMany.mockResolvedValue(members);
    llmService.generateStructured.mockResolvedValue({
      agentId: 'agent-ghost',
      reason: '?',
    });

    const result = await service.route('画图', [
      'agent-general',
      'agent-painter',
    ]);
    expect(result.agentId).toBe('agent-general');
    expect(result.source).toBe('fallback');
  });

  it('结构化与降级路径均失败（返回 null）时回退并标记 fallback', async () => {
    const { service, prisma, llmService } = createService();
    prisma.agent.findMany.mockResolvedValue(members);
    llmService.generateStructured.mockResolvedValue(null);

    const result = await service.route('画图', [
      'agent-general',
      'agent-painter',
    ]);
    expect(result.agentId).toBe('agent-general');
    expect(result.source).toBe('fallback');
  });

  it('模型异常时回退第一个成员并标记 fallback，不阻塞发送链路', async () => {
    const { service, prisma, llmService } = createService();
    prisma.agent.findMany.mockResolvedValue(members);
    llmService.generateStructured.mockRejectedValue(new Error('llm down'));

    const result = await service.route('画图', [
      'agent-general',
      'agent-painter',
    ]);
    expect(result.agentId).toBe('agent-general');
    expect(result.source).toBe('fallback');
  });
});
