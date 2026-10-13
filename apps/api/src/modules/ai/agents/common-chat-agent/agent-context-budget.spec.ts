import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { prepareAgentMessages } from './agent-context-budget';

const round = (id: string, content: string) => [
  new AIMessage({
    content: '',
    tool_calls: [{ id, name: 'search', args: { query: id } }],
  }),
  new ToolMessage({ content, tool_call_id: id, name: 'search' }),
];

describe('Agent 工具循环上下文预算', () => {
  it('小请求原样通过，不增加摘要调用', async () => {
    const messages = [new HumanMessage('问题'), ...round('1', '结果')];
    const summarize = jest.fn();
    expect(
      await prepareAgentMessages(messages, 100, {
        inputTokenLimit: 5000,
        protectedMessageCount: 1,
        summarize,
      }),
    ).toBe(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('压缩旧工具轮次并保留原始用户输入、最新调用和结果配对', async () => {
    const input = new HumanMessage('完整正文与用户要求');
    const latest = round('new', '新的结果'.repeat(300));
    const messages = [input, ...round('old', '历史'.repeat(1050)), ...latest];
    const summarize = jest
      .fn()
      .mockResolvedValue('旧查询已完成，来源为测试站点');
    const onSummaryModelCall = jest.fn();
    const result = await prepareAgentMessages(messages, 100, {
      inputTokenLimit: 6000,
      protectedMessageCount: 1,
      summarize,
      onSummaryModelCall,
    });
    expect(result[0]).toBe(input);
    expect(result.slice(-2)).toEqual(latest);
    expect(result[1].content).toContain('旧查询已完成');
    expect(onSummaryModelCall).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(5);
  });

  it('超大最新工具结果明确失败，不截断、不拆散调用', async () => {
    const messages = [
      new HumanMessage('原文'),
      ...round('large', '内容'.repeat(3000)),
    ];
    const summarize = jest.fn();
    await expect(
      prepareAgentMessages(messages, 100, {
        inputTokenLimit: 4000,
        protectedMessageCount: 1,
        summarize,
      }),
    ).rejects.toThrow('超过模型上下文预算');
    expect(summarize).not.toHaveBeenCalled();
  });

  it('审批恢复使用同样的输入保护边界，不能为腾空间删除用户正文', async () => {
    const messages = [
      new HumanMessage('正文'.repeat(3000)),
      ...round('approved', '已通过并执行'),
    ];
    await expect(
      prepareAgentMessages(messages, 100, {
        inputTokenLimit: 4000,
        protectedMessageCount: 1,
        summarize: jest.fn(),
      }),
    ).rejects.toThrow('超过模型上下文预算');
  });

  it('摘要异常向上传递，不能把失败当作空上下文继续', async () => {
    const messages = [
      new HumanMessage('问题'),
      ...round('old', '历史'.repeat(1050)),
      ...round('new', '结果'.repeat(600)),
    ];
    await expect(
      prepareAgentMessages(messages, 100, {
        inputTokenLimit: 6000,
        protectedMessageCount: 1,
        summarize: jest.fn().mockRejectedValue(new Error('摘要服务不可用')),
      }),
    ).rejects.toThrow('摘要服务不可用');
  });
});

// 使用真实 LangGraph messages 流，验证中间件修改的是发包输入，内部摘要不会变成助手正文。
describe('上下文预算中间件集成', () => {
  it('真正压缩模型输入，同时隐藏摘要模型的流式内容并保留 checkpoint 原文', async () => {
    const { Test } = await import('@nestjs/testing');
    const { ConfigService } = await import('@nestjs/config');
    const { FakeListChatModel } = await import('@langchain/core/utils/testing');
    const { MemorySaver } = await import('@langchain/langgraph');
    const { LlmService } = await import('../../../llm/llm.service');
    const { LlmModelRegistryService } =
      await import('../../../llm/llm-model-registry.service');
    const { LlmChatModelFactory } =
      await import('../../../llm/providers/chat-model.factory');
    const { CommonChatAgentFactory } =
      await import('./common-chat-agent.factory');
    const { createAgentContextBudgetMiddleware } =
      await import('./agent-context-budget');
    const summaryModel = new FakeListChatModel({ responses: ['内部工具摘要'] });
    const module = await Test.createTestingModule({
      providers: [
        LlmService,
        {
          provide: LlmModelRegistryService,
          useValue: {
            resolveTextRequest: () => ({
              model: { id: 'test', provider: 'openai', model: 'test' },
              generation: {},
            }),
          },
        },
        {
          provide: LlmChatModelFactory,
          useValue: { createChatModel: () => summaryModel },
        },
        { provide: ConfigService, useValue: { get: () => false } },
      ],
    }).compile();
    const inputs: string[] = [];
    const model = new FakeListChatModel({ responses: ['最终答案'] });
    const agent = new CommonChatAgentFactory().createAgent({
      model,
      systemPrompt: '帮助用户',
      checkpointer: new MemorySaver(),
      middleware: [
        createAgentContextBudgetMiddleware({
          inputTokenLimit: 6000,
          protectedMessageCount: 1,
          summarize: (text) =>
            module
              .get(LlmService)
              .generateChatText([{ role: 'user', content: text }], undefined, {
                suppressStream: true,
              }),
        }),
      ],
    });
    const messages = [
      new HumanMessage('原始要求'),
      ...round('old', '历史'.repeat(1050)),
      ...round('new', '结果'.repeat(600)),
    ];
    const config = { configurable: { thread_id: 'context-test' } };
    const stream = await agent.stream(
      { messages },
      {
        ...config,
        streamMode: 'messages',
        callbacks: [
          {
            handleChatModelStart(_serialized, messages) {
              inputs.push(
                messages
                  .flat()
                  .map((message) => message.text)
                  .join('\n'),
              );
            },
          },
        ],
      },
    );
    let output = '';
    for await (const [message] of stream)
      if (message.type === 'ai') output += String(message.content);
    expect(output).toBe('最终答案');
    expect(inputs).toHaveLength(2);
    const finalInput = inputs.find((input) => input.includes('帮助用户'));
    expect(finalInput).toContain('内部工具摘要');
    expect(finalInput).not.toContain('历史'.repeat(1050));
    const state = await agent.getState(config);
    expect(state.values.messages).toHaveLength(messages.length + 1);
  });
});
