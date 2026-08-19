import { StreamTaskStatus } from '@prisma/client';
import { AgentFlowCancellationDispatcherService } from './agent-flow-cancellation-dispatcher.service';

describe('AgentFlowCancellationDispatcherService', () => {
  it('向尚未投递取消信号的已取消 Flow 任务发送 Temporal Signal 并记录投递状态', async () => {
    const prisma = {
      streamTask: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'task-1',
            temporalWorkflowId: 'task-1',
            executionState: { agentFlow: { started: true } },
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const temporalClient = {
      signalCancel: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AgentFlowCancellationDispatcherService(
      prisma as never,
      temporalClient as never,
    );

    await service.dispatchPending();

    expect(temporalClient.signalCancel).toHaveBeenCalledWith({
      workflowId: 'task-1',
    });
    expect(prisma.streamTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'task-1',
        status: StreamTaskStatus.CANCELED,
        temporalWorkflowId: 'task-1',
      },
      data: {
        executionState: expect.objectContaining({
          agentFlow: expect.objectContaining({
            cancelSignalDeliveredAt: expect.any(String),
          }),
        }),
      },
    });
  });

  it('已记录取消 Signal 投递状态的任务不会重复发送', async () => {
    const prisma = {
      streamTask: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'task-1',
            temporalWorkflowId: 'task-1',
            executionState: {
              agentFlow: {
                cancelSignalDeliveredAt: '2026-08-18T00:00:00.000Z',
              },
            },
          },
        ]),
        updateMany: jest.fn(),
      },
    };
    const temporalClient = { signalCancel: jest.fn() };
    const service = new AgentFlowCancellationDispatcherService(
      prisma as never,
      temporalClient as never,
    );

    await service.dispatchPending();

    expect(temporalClient.signalCancel).not.toHaveBeenCalled();
    expect(prisma.streamTask.updateMany).not.toHaveBeenCalled();
  });
});
