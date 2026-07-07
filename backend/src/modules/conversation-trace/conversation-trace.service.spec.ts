import { ConversationTraceService } from './conversation-trace.service';
import {
  ConversationTraceItemStatus,
  ConversationTraceItemType,
} from './conversation-trace.types';

const expectObjectContaining = <T extends Record<string, unknown>>(value: T) =>
  expect.objectContaining(value) as unknown;

describe('ConversationTraceService', () => {
  const createPrismaMock = () => ({
    conversationTurnTraceItem: {
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  });

  it('updates the same trace item when a running item is completed by traceKey', async () => {
    const prisma = createPrismaMock();
    const service = new ConversationTraceService(prisma as never);

    prisma.conversationTurnTraceItem.count.mockResolvedValue(0);
    prisma.conversationTurnTraceItem.create.mockResolvedValue({
      id: 'trace-1',
      traceKey: 'tool:call-1',
      status: ConversationTraceItemStatus.RUNNING,
      startedAt: new Date('2026-07-02T10:00:00.000Z'),
    });
    prisma.conversationTurnTraceItem.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'trace-1',
        startedAt: new Date('2026-07-02T10:00:00.000Z'),
      });
    prisma.conversationTurnTraceItem.update.mockResolvedValue({
      id: 'trace-1',
      status: ConversationTraceItemStatus.SUCCESS,
    });

    await service.startItem({
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      taskId: 'task-1',
      runId: 'run-1',
      traceKey: 'tool:call-1',
      type: ConversationTraceItemType.TOOL_CALL,
      title: '调用工具',
      startedAt: new Date('2026-07-02T10:00:00.000Z'),
    });

    await service.completeItem({
      taskId: 'task-1',
      traceKey: 'tool:call-1',
      summary: '工具调用成功',
      endedAt: new Date('2026-07-02T10:00:01.250Z'),
    });

    expect(prisma.conversationTurnTraceItem.create).toHaveBeenCalledWith(
      expectObjectContaining({
        data: expectObjectContaining({
          sequence: 1,
          traceKey: 'tool:call-1',
          status: ConversationTraceItemStatus.RUNNING,
        }),
      }),
    );
    expect(prisma.conversationTurnTraceItem.update).toHaveBeenCalledWith({
      where: { id: 'trace-1' },
      data: expectObjectContaining({
        status: ConversationTraceItemStatus.SUCCESS,
        durationMs: 1250,
        summary: '工具调用成功',
      }),
    });
  });

  it('creates a failed trace item when no running item can be matched', async () => {
    const prisma = createPrismaMock();
    const service = new ConversationTraceService(prisma as never);

    prisma.conversationTurnTraceItem.findFirst.mockResolvedValue(null);
    prisma.conversationTurnTraceItem.count.mockResolvedValue(2);
    prisma.conversationTurnTraceItem.create.mockResolvedValue({
      id: 'trace-3',
      status: ConversationTraceItemStatus.ERROR,
    });

    await service.failItem({
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      taskId: 'task-1',
      traceKey: 'tool:missing',
      type: ConversationTraceItemType.TOOL_CALL,
      title: '工具调用失败',
      error: { message: 'timeout' },
      endedAt: new Date('2026-07-02T10:00:02.000Z'),
    });

    expect(prisma.conversationTurnTraceItem.create).toHaveBeenCalledWith(
      expectObjectContaining({
        data: expectObjectContaining({
          sequence: 3,
          status: ConversationTraceItemStatus.ERROR,
          error: { message: 'timeout' },
        }),
      }),
    );
  });
});
