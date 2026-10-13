import {
  FlowContextService,
  type PrepareFlowContext,
} from './flow-context.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChatContextService } from '../../memory/chat-context.service';
import { LlmModelRegistryService } from '../../llm/llm-model-registry.service';
import { Test } from '@nestjs/testing';

describe('FlowContextService', () => {
  const snapshots = new Map<string, unknown>();
  const prisma = {
    agentFlowNodeContext: { findUnique: jest.fn(), upsert: jest.fn() },
    agentFlowNodeExecution: { findMany: jest.fn() },
  };
  const chat = { buildContextBundle: jest.fn() };
  const models = { getContextLimits: jest.fn() };
  let service: FlowContextService;
  const request: PrepareFlowContext = {
    taskId: 'task-1',
    nodeExecutionId: 'writer#1',
    phase: 'model',
    conversationId: 'conversation-1',
    pendingMessageId: 'answer-1',
    agentId: 'agent-1',
    modelPreset: 'large',
    policy: { conversation: 'auto' },
    systemPrompt: '帮助用户写作',
    currentInput: '修改开头',
    startNodeKey: 'start',
  };
  beforeEach(async () => {
    jest.resetAllMocks();
    snapshots.clear();
    models.getContextLimits.mockImplementation((preset: string) => ({
      modelPreset: preset,
      contextWindowTokens: preset === 'small' ? 8000 : 32000,
      maxOutputTokens: 2048,
    }));
    chat.buildContextBundle.mockResolvedValue({
      messages: [{ role: 'user', content: '修改开头' }],
      messageIds: ['user-1'],
    });
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([]);
    prisma.agentFlowNodeContext.findUnique.mockImplementation(({ where }) => {
      const snapshot = snapshots.get(JSON.stringify(where));
      return Promise.resolve(snapshot ? { snapshot } : null);
    });
    prisma.agentFlowNodeContext.upsert.mockImplementation(
      ({ where, create }) => {
        const key = JSON.stringify(where);
        if (!snapshots.has(key))
          snapshots.set(key, structuredClone(create.snapshot));
        return Promise.resolve({ snapshot: snapshots.get(key) });
      },
    );
    const module = await Test.createTestingModule({
      providers: [
        FlowContextService,
        { provide: PrismaService, useValue: prisma },
        { provide: ChatContextService, useValue: chat },
        { provide: LlmModelRegistryService, useValue: models },
      ],
    }).compile();
    service = module.get(FlowContextService);
  });

  it('普通对话默认保留本轮输入和历史，并按节点模型设置预算', async () => {
    const snapshot = await service.prepare(request);
    expect(snapshot.messages).toEqual([{ role: 'user', content: '修改开头' }]);
    expect(snapshot.manifest.messageIds).toEqual(['user-1']);
    const small = await service.prepare({
      ...request,
      taskId: 'task-2',
      modelPreset: 'small',
    });
    expect(small.inputTokenLimit).toBeLessThan(snapshot.inputTokenLimit);
  });

  it('none 不查询会话历史，上游正文以数据消息传递且只绑定声明的输出', async () => {
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([
      {
        nodeKey: 'writer',
        nodeExecutionId: 'writer#1',
        outputs: { text: '旧稿' },
      },
      {
        nodeKey: 'writer',
        nodeExecutionId: 'writer#2',
        outputs: { text: '新版正文' },
      },
    ]);
    const snapshot = await service.prepare({
      ...request,
      policy: { conversation: 'none' },
      inputRefs: [{ $ref: ['writer', 'text'] }],
    });
    expect(chat.buildContextBundle).not.toHaveBeenCalled();
    expect(snapshot.messages.map((message) => message.role)).toEqual([
      'user',
      'user',
    ]);
    expect(snapshot.messages[1].content).toContain('新版正文');
    expect(snapshot.manifest.sources).toEqual([
      { nodeKey: 'writer', nodeExecutionId: 'writer#2', field: 'text' },
    ]);
  });

  it('显式引用 start.text 时不重复注入当前消息', async () => {
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([
      {
        nodeKey: 'start',
        nodeExecutionId: 'start#0',
        outputs: { text: '修改开头' },
      },
    ]);
    const snapshot = await service.prepare({
      ...request,
      policy: { conversation: 'none' },
      inputRefs: [{ $ref: ['start', 'text'] }],
    });
    expect(snapshot.messages).toHaveLength(1);
    await service.prepare({
      ...request,
      taskId: 'auto-ref',
      inputRefs: [{ $ref: ['start', 'text'] }],
    });
    expect(chat.buildContextBundle).toHaveBeenLastCalledWith(
      'conversation-1',
      'answer-1',
      'agent-1',
      expect.objectContaining({ includeCurrentInput: false }),
    );
  });

  it('恢复使用已保存的正文、摘要和指令，不重新读取变化的历史或上游', async () => {
    const first = await service.prepare(request);
    chat.buildContextBundle.mockRejectedValue(new Error('不应读取新的历史'));
    const second = await service.prepare({
      ...request,
      systemPrompt: '被编辑的新指令',
      inputRefs: [{ $ref: ['unknown', 'text'] }],
    });
    expect(second).toEqual(first);
    expect(chat.buildContextBundle).toHaveBeenCalledTimes(1);
    expect(prisma.agentFlowNodeExecution.findMany).not.toHaveBeenCalled();
  });

  it('计划步骤、重规划与不同循环轮次拥有独立快照', async () => {
    await service.prepare(request);
    await service.prepare({ ...request, phase: 'step:2' });
    await service.prepare({ ...request, nodeExecutionId: 'writer#2' });
    expect(snapshots.size).toBe(3);
  });

  it('摘要策略和节点输入上限真正传递给历史组装', async () => {
    await service.prepare({
      ...request,
      policy: { conversation: 'summary', maxInputTokens: 6000 },
    });
    expect(chat.buildContextBundle).toHaveBeenCalledWith(
      'conversation-1',
      'answer-1',
      'agent-1',
      expect.objectContaining({
        conversation: 'summary',
        maxInputTokens: 6000,
      }),
    );
  });

  it('缺失上游和超大必要输入直接失败，不写入可执行快照', async () => {
    await expect(
      service.prepare({
        ...request,
        inputRefs: [{ $ref: ['missing', 'text'] }],
      }),
    ).rejects.toThrow('没有已完成的输出');
    await expect(
      service.prepare({
        ...request,
        policy: { conversation: 'none', maxInputTokens: 1024 },
        currentInput: '内容'.repeat(3000),
      }),
    ).rejects.toThrow('超出上下文预算');
    expect(snapshots.size).toBe(0);
  });
});
