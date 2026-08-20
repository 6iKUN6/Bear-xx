import { AgentFlowSignalOutboxStatus } from '@prisma/client';
import { AgentFlowSignalOutboxService } from './agent-flow-signal-outbox.service';

describe('AgentFlowSignalOutboxService', () => {
  /**
   * 读取最后一次 outbox 写入的 data 载荷
   * @param prisma 测试替身
   * @returns 返回最后一次 updateMany 的 data 字段
   * @description 退避时长与终态判定需要断言具体值，而 toHaveBeenLastCalledWith 只能匹配类型。
   */
  function getLastUpdateData(prisma: {
    agentFlowSignalOutbox: { updateMany: jest.Mock };
  }): Record<string, unknown> {
    const calls = prisma.agentFlowSignalOutbox.updateMany.mock.calls;
    const last = calls[calls.length - 1] as [{ data: Record<string, unknown> }];
    return last[0].data;
  }

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
        nextAttemptAt: null,
      },
    });
  });

  it('只拾取退避已到期的待投递记录', async () => {
    const { service, prisma } = createService();
    prisma.agentFlowSignalOutbox.findMany.mockResolvedValue([]);
    prisma.agentFlowSignalOutbox.updateMany.mockResolvedValue({ count: 0 });

    await service.dispatchPending();

    expect(prisma.agentFlowSignalOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: AgentFlowSignalOutboxStatus.PENDING,
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: expect.any(Date) } },
          ],
        }),
      }),
    );
  });

  it('Signal 失败时回到待投递状态并按指数退避安排下次尝试', async () => {
    const { service, prisma, temporalClient } = createService();
    prisma.agentFlowSignalOutbox.findMany.mockResolvedValue([
      {
        id: 'outbox-1',
        taskId: 'task-1',
        approvalId: 'approval-1',
        status: AgentFlowSignalOutboxStatus.PENDING,
        attempts: 2,
      },
    ]);
    prisma.agentFlowSignalOutbox.updateMany.mockResolvedValue({ count: 1 });
    temporalClient.signalApproval.mockRejectedValue(new Error('网络暂不可用'));

    const before = Date.now();
    await service.dispatchPending();

    expect(prisma.agentFlowSignalOutbox.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'outbox-1',
        status: AgentFlowSignalOutboxStatus.SENDING,
      },
      data: {
        status: AgentFlowSignalOutboxStatus.PENDING,
        lastError: '网络暂不可用',
        nextAttemptAt: expect.any(Date),
      },
    });
    // 第 3 次失败对应 5s * 2^2 = 20s；断言退避确实生效而非固定间隔重试
    const { nextAttemptAt } = getLastUpdateData(prisma);
    expect((nextAttemptAt as Date).getTime() - before).toBeGreaterThanOrEqual(
      20_000,
    );
  });

  it('重试次数耗尽后转 FAILED 终态，不再占用派发批次', async () => {
    const { service, prisma, temporalClient } = createService();
    prisma.agentFlowSignalOutbox.findMany.mockResolvedValue([
      {
        id: 'outbox-1',
        taskId: 'task-1',
        approvalId: 'approval-1',
        status: AgentFlowSignalOutboxStatus.PENDING,
        // 第 8 次尝试即到达上限
        attempts: 7,
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
        status: AgentFlowSignalOutboxStatus.FAILED,
        lastError: '网络暂不可用',
        nextAttemptAt: null,
      },
    });
  });

  it('目标 Workflow 已关闭时立即转 FAILED，不做无意义重试', async () => {
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
    temporalClient.signalApproval.mockRejectedValue(
      new Error('workflow execution already completed'),
    );

    await service.dispatchPending();

    expect(getLastUpdateData(prisma).status).toBe(
      AgentFlowSignalOutboxStatus.FAILED,
    );
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
