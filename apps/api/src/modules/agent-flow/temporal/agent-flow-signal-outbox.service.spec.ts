import { AgentFlowSignalOutboxStatus } from '@prisma/client';
import { AgentFlowSignalOutboxService } from './agent-flow-signal-outbox.service';

describe('AgentFlowSignalOutboxService', () => {
  function createService() {
    const prisma = {
      agentFlowSignalOutbox: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const temporalClient = {
      signalApproval: jest.fn(),
    };

    return {
      service: new AgentFlowSignalOutboxService(
        prisma as never,
        temporalClient as never,
      ),
      prisma,
      temporalClient,
    };
  }

  it('仅向 Temporal 发送 approvalId，并在成功后标记 outbox 已投递', async () => {
    const { service, prisma, temporalClient } = createService();
    prisma.agentFlowSignalOutbox.findMany.mockResolvedValue([
      {
        id: 'outbox-1',
        taskId: 'task-1',
        approvalId: 'approval-1',
        status: AgentFlowSignalOutboxStatus.PENDING,
        attempts: 0,
      },
    ]);
    prisma.agentFlowSignalOutbox.updateMany.mockResolvedValue({ count: 1 });

    await service.dispatchPending();

    expect(temporalClient.signalApproval).toHaveBeenCalledWith({
      workflowId: 'task-1',
      approvalId: 'approval-1',
    });
    expect(temporalClient.signalApproval.mock.calls[0][0]).not.toHaveProperty(
      'decision',
    );
    expect(prisma.agentFlowSignalOutbox.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'outbox-1',
        status: AgentFlowSignalOutboxStatus.SENDING,
      },
      data: {
        status: AgentFlowSignalOutboxStatus.DELIVERED,
        deliveredAt: expect.any(Date),
        lastError: null,
      },
    });
  });

  it('Signal 失败时回到待投递状态并记录安全错误信息', async () => {
    const { service, prisma, temporalClient } = createService();
    prisma.agentFlowSignalOutbox.findMany.mockResolvedValue([
      {
        id: 'outbox-1',
        taskId: 'task-1',
        approvalId: 'approval-1',
        status: AgentFlowSignalOutboxStatus.PENDING,
        attempts: 0,
      },
    ]);
    prisma.agentFlowSignalOutbox.updateMany.mockResolvedValue({ count: 1 });
    temporalClient.signalApproval.mockRejectedValue(new Error('网络暂不可用'));

    await service.dispatchPending();

    expect(prisma.agentFlowSignalOutbox.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'outbox-1',
        status: AgentFlowSignalOutboxStatus.SENDING,
      },
      data: {
        status: AgentFlowSignalOutboxStatus.PENDING,
        lastError: '网络暂不可用',
      },
    });
  });

  it('回收进程中断后遗留的 SENDING 记录，使其可被下一轮派发重试', async () => {
    const { service, prisma } = createService();
    prisma.agentFlowSignalOutbox.findMany.mockResolvedValue([]);
    prisma.agentFlowSignalOutbox.updateMany.mockResolvedValue({ count: 1 });

    await service.dispatchPending();

    expect(prisma.agentFlowSignalOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        status: AgentFlowSignalOutboxStatus.SENDING,
        updatedAt: { lt: expect.any(Date) },
      },
      data: {
        status: AgentFlowSignalOutboxStatus.PENDING,
        lastError: 'Signal 投递租约已超时，等待重新派发',
      },
    });
  });
});
