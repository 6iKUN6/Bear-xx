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
});
