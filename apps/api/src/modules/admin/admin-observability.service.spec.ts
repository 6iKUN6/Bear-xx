import { AdminObservabilityService } from './admin-observability.service';

function buildService(prisma: Record<string, unknown>) {
  return new AdminObservabilityService(prisma as never);
}

describe('AdminObservabilityService', () => {
  it('aggregates agent usage folding (agentId,status) groups', async () => {
    const prisma = {
      streamTask: {
        groupBy: jest.fn().mockResolvedValue([
          { agentId: 'a1', status: 'COMPLETED', _count: { _all: 8 } },
          { agentId: 'a1', status: 'ERROR', _count: { _all: 2 } },
          { agentId: null, status: 'COMPLETED', _count: { _all: 5 } },
        ]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      agent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = buildService(prisma);
    const usage = await service.agentUsage(7);

    const a1 = usage.find((u) => u.agentId === 'a1');
    expect(a1).toMatchObject({ taskCount: 10, completedCount: 8 });
    expect(a1?.successRate).toBeCloseTo(0.8);
    const def = usage.find((u) => u.agentId === null);
    expect(def).toMatchObject({ taskCount: 5, completedCount: 5 });
    // 按 taskCount 倒序
    expect(usage[0].agentId).toBe('a1');
  });

  it('enriches agent usage with the agent display profile', async () => {
    const prisma = {
      streamTask: {
        groupBy: jest
          .fn()
          .mockResolvedValue([
            { agentId: 'a1', status: 'COMPLETED', _count: { _all: 3 } },
          ]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      agent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'a1',
            name: '研究助手',
            avatar: 'https://cdn.example.com/research.png',
          },
        ]),
      },
    };

    const usage = await buildService(prisma).agentUsage(7);

    expect(usage[0]).toMatchObject({
      agentId: 'a1',
      agentName: '研究助手',
      agentAvatar: 'https://cdn.example.com/research.png',
    });
  });

  it('enriches recent tasks with the agent display profile', async () => {
    const startedAt = new Date('2026-07-28T00:00:00.000Z');
    const completedAt = new Date('2026-07-28T00:00:01.000Z');
    const prisma = {
      streamTask: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'task-1',
            agentId: 'a1',
            type: 'CHAT_COMPLETION',
            status: 'COMPLETED',
            errorMessage: null,
            startedAt,
            completedAt,
            createdAt: startedAt,
            resultPayload: null,
          },
        ]),
      },
      agent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'a1',
            name: '研究助手',
            avatar: 'https://cdn.example.com/research.png',
          },
        ]),
      },
    };

    const tasks = await buildService(prisma).recentTasks(7);

    expect(tasks.items[0]).toMatchObject({
      agentId: 'a1',
      agentName: '研究助手',
      agentAvatar: 'https://cdn.example.com/research.png',
    });
  });

  it('aggregates tool usage with success rate and weighted avg duration', async () => {
    const prisma = {
      conversationTurnTraceItem: {
        groupBy: jest.fn().mockResolvedValue([
          {
            toolName: 'webSearch',
            status: 'SUCCESS',
            _count: { _all: 4 },
            _avg: { durationMs: 800 },
          },
          {
            toolName: 'webSearch',
            status: 'ERROR',
            _count: { _all: 1 },
            _avg: { durationMs: 300 },
          },
        ]),
      },
    };
    const service = buildService(prisma);
    const tools = await service.toolUsage(7);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolName: 'webSearch',
      callCount: 5,
      successCount: 4,
    });
    expect(tools[0].successRate).toBeCloseTo(0.8);
    // 加权平均：(800*4 + 300*1)/5 = 700
    expect(tools[0].avgDurationMs).toBe(700);
  });

  it('classifies error breakdown by category', async () => {
    const prisma = {
      streamTask: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { errorMessage: 'Request timeout after 30000ms' },
            { errorMessage: 'read ECONNRESET' },
            { errorMessage: 'weird failure' },
          ]),
      },
    };
    const service = buildService(prisma);
    const errors = await service.errorBreakdown(7);
    const map = Object.fromEntries(errors.map((e) => [e.category, e.count]));
    expect(map.timeout).toBe(1);
    expect(map.network).toBe(1);
    expect(map.unknown).toBe(1);
  });

  it('extracts token/counts from resultPayload in task summary', async () => {
    const prisma = {
      streamTask: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          agentId: 'a1',
          type: 'CHAT_COMPLETION',
          status: 'COMPLETED',
          errorMessage: null,
          startedAt: new Date('2026-07-28T00:00:00.000Z'),
          completedAt: new Date('2026-07-28T00:00:03.200Z'),
          createdAt: new Date('2026-07-28T00:00:00.000Z'),
          resultPayload: {
            metrics: {
              tokenUsage: { totalTokens: 1500 },
              toolCallCount: 2,
              modelCallCount: 3,
            },
          },
        }),
      },
      conversationTurnTraceItem: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      agent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = buildService(prisma);
    const detail = await service.taskDetail('t1');
    expect(detail).toMatchObject({
      totalTokens: 1500,
      toolCallCount: 2,
      modelCallCount: 3,
      durationMs: 3200,
    });
    expect(detail.trace).toEqual([]);
  });

  it('returns structured trace fields for the provenance viewer', async () => {
    const startedAt = new Date('2026-07-28T00:00:00.000Z');
    const endedAt = new Date('2026-07-28T00:00:01.200Z');
    const createdAt = new Date('2026-07-28T00:00:00.000Z');
    const prisma = {
      streamTask: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          agentId: 'a1',
          type: 'CHAT_COMPLETION',
          status: 'COMPLETED',
          errorMessage: null,
          startedAt,
          completedAt: endedAt,
          createdAt,
          resultPayload: null,
        }),
      },
      conversationTurnTraceItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'trace-1',
            type: 'TOOL_CALL',
            status: 'SUCCESS',
            title: '查询天气',
            summary: '已获取深圳天气',
            detail: '调用 getWeather',
            toolName: 'getWeather',
            parentId: 'trace-root',
            depth: 2,
            nodeKey: 'weather_lookup',
            mcpServer: 'weather',
            mcpTool: 'getWeather',
            inputSummary: { city: '深圳' },
            outputSummary: { condition: '晴' },
            error: null,
            metrics: { durationMs: 1200 },
            startedAt,
            endedAt,
            createdAt,
            durationMs: 1200,
            sequence: 3,
          },
        ]),
      },
      agent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const detail = await buildService(prisma).taskDetail('t1');

    expect(detail.trace).toEqual([
      expect.objectContaining({
        parentId: 'trace-root',
        depth: 2,
        detail: '调用 getWeather',
        nodeKey: 'weather_lookup',
        mcpServer: 'weather',
        mcpTool: 'getWeather',
        inputSummary: { city: '深圳' },
        outputSummary: { condition: '晴' },
        metrics: { durationMs: 1200 },
        startedAt: startedAt.getTime(),
        endedAt: endedAt.getTime(),
        createdAt: createdAt.getTime(),
      }),
    ]);
  });
});
