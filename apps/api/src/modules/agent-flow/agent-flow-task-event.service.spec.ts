import { StreamTaskStatus } from '@prisma/client';
import { StreamTaskEventType } from '@litter-bear/types/protocol';
import { AgentFlowTaskEventService } from './agent-flow-task-event.service';

describe('AgentFlowTaskEventService', () => {
  function createService() {
    const snapshotService = {
      appendFrame: jest.fn(),
    };
    const registry = {
      publish: jest.fn(),
    };
    const conversationTraceService = {
      recordStreamEventInTransaction: jest.fn(),
    };
    const configService = {
      get: jest.fn().mockReturnValue(300),
    };
    const service = new AgentFlowTaskEventService(
      snapshotService as never,
      registry as never,
      conversationTraceService as never,
      configService as never,
    );
    return { service, snapshotService, registry, conversationTraceService };
  }

  it('在事务内持久化 Flow 语义事件与 trace，Redis 帧留到提交后', async () => {
    const { service, snapshotService, conversationTraceService } =
      createService();
    const transaction = {
      streamTask: {
        update: jest.fn().mockResolvedValue({ lastEventId: 7 }),
      },
      streamTaskEvent: {
        create: jest.fn(),
      },
    };

    const draft = await service.persistInTransaction(transaction as never, {
      taskId: 'task-1',
      streamId: 'run-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      eventName: StreamTaskEventType.FlowRunResumed,
      status: StreamTaskStatus.WAITING_HUMAN,
      payload: { runSequence: 1, reason: 'approval' },
    });

    expect(draft).toEqual({
      taskId: 'task-1',
      eventId: 7,
      eventName: StreamTaskEventType.FlowRunResumed,
      data: JSON.stringify({
        type: StreamTaskEventType.FlowRunResumed,
        taskId: 'task-1',
        streamId: 'run-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        status: 'waiting_human',
        payload: { runSequence: 1, reason: 'approval' },
      }),
    });
    expect(transaction.streamTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: expect.objectContaining({
        lastEventId: { increment: 1 },
        status: StreamTaskStatus.WAITING_HUMAN,
      }),
      select: { lastEventId: true },
    });
    expect(transaction.streamTaskEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: 'task-1',
        streamId: 'run-1',
        eventId: 7,
        eventName: StreamTaskEventType.FlowRunResumed,
      }),
    });
    expect(
      conversationTraceService.recordStreamEventInTransaction,
    ).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        eventName: StreamTaskEventType.FlowRunResumed,
        payload: { runSequence: 1, reason: 'approval' },
      }),
    );
    expect(snapshotService.appendFrame).not.toHaveBeenCalled();
  });

  it('只在事务提交后写 Redis 帧并通知本机 SSE 订阅者', async () => {
    const { service, snapshotService, registry } = createService();
    snapshotService.appendFrame.mockResolvedValue({
      id: '1770000000000-0',
      event: StreamTaskEventType.FlowRunResumed,
      data: '{"type":"flow.run.resumed"}',
    });

    await service.publishAfterCommit({
      taskId: 'task-1',
      eventId: 7,
      eventName: StreamTaskEventType.FlowRunResumed,
      data: '{"type":"flow.run.resumed"}',
    });

    expect(snapshotService.appendFrame).toHaveBeenCalledWith(
      'task-1',
      StreamTaskEventType.FlowRunResumed,
      '{"type":"flow.run.resumed"}',
    );
    expect(registry.publish).toHaveBeenCalledWith('task-1', {
      id: '1770000000000-0',
      event: StreamTaskEventType.FlowRunResumed,
      data: '{"type":"flow.run.resumed"}',
    });
  });
});
