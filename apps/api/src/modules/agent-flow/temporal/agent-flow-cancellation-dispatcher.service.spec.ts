import { StreamTaskStatus } from '@prisma/client';
import { AgentFlowCancellationDispatcherService } from './agent-flow-cancellation-dispatcher.service';

describe('AgentFlowCancellationDispatcherService', () => {
  function createService(
    tasks: Array<{
      id: string;
      temporalWorkflowId: string;
      executionState: unknown;
    }>,
  ) {
    const prisma = {
      streamTask: {
        findMany: jest.fn().mockResolvedValue(tasks),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const temporalClient = {
      signalCancel: jest.fn().mockResolvedValue(undefined),
    };
    return {
      service: new AgentFlowCancellationDispatcherService(
        prisma as never,
        temporalClient as never,
      ),
      prisma,
      temporalClient,
    };
  }

  it('向尚未投递取消信号的已取消 Flow 任务发送 Temporal Signal 并记录投递状态', async () => {
    const { service, prisma, temporalClient } = createService([
      {
        id: 'task-1',
        temporalWorkflowId: 'task-1',
        executionState: { agentFlow: { started: true } },
      },
    ]);

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
        cancelSignalSettledAt: expect.any(Date),
        executionState: expect.objectContaining({
          agentFlow: expect.objectContaining({
            cancelSignalDeliveredAt: expect.any(String),
          }),
        }),
      },
    });
  });

  it('在 SQL 层排除已处理任务，避免队头记录挤占派发批次', async () => {
    const { service, prisma } = createService([]);

    await service.dispatchPending();

    expect(prisma.streamTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: StreamTaskStatus.CANCELED,
          cancelSignalSettledAt: null,
        }),
      }),
    );
  });

  it('目标 Workflow 已关闭时同样落终态标记，不再重复扫描', async () => {
    const { service, prisma, temporalClient } = createService([
      {
        id: 'task-1',
        temporalWorkflowId: 'task-1',
        executionState: null,
      },
    ]);
    temporalClient.signalCancel.mockRejectedValue(
      new Error('workflow execution already completed'),
    );

    await service.dispatchPending();

    expect(prisma.streamTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cancelSignalSettledAt: expect.any(Date),
        }),
      }),
    );
  });

  it('瞬时错误保留未处理状态，交由下一轮扫描重试', async () => {
    const { service, prisma, temporalClient } = createService([
      {
        id: 'task-1',
        temporalWorkflowId: 'task-1',
        executionState: null,
      },
    ]);
    temporalClient.signalCancel.mockRejectedValue(new Error('网络暂不可用'));

    await service.dispatchPending();

    expect(prisma.streamTask.updateMany).not.toHaveBeenCalled();
  });
});
