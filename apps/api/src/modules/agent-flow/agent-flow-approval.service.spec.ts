import { Test, type TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentFlowApprovalService } from './agent-flow-approval.service';
import { AgentFlowTaskEventService } from './agent-flow-task-event.service';

describe('AgentFlowApprovalService', () => {
  let service: AgentFlowApprovalService;
  let findUnique: jest.Mock<Promise<Record<string, unknown> | null>, [unknown]>;
  let updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;

  beforeEach(async () => {
    findUnique = jest.fn<Promise<Record<string, unknown> | null>, [unknown]>();
    updateMany = jest.fn<Promise<{ count: number }>, [unknown]>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentFlowApprovalService,
        {
          provide: PrismaService,
          useValue: {
            agentFlowApproval: { findUnique, updateMany },
          },
        },
        {
          provide: AgentFlowTaskEventService,
          useValue: {
            persistInTransaction: jest.fn(),
            publishAfterCommit: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(AgentFlowApprovalService);
  });

  it('重复提交相同决定时返回首次决定，不覆盖审批记录', async () => {
    const pendingApproval = {
      id: 'approval-1',
      taskId: 'task-1',
      status: 'PENDING',
      decision: null,
      decidedAt: null,
      decidedById: null,
    };
    const resolvedApproval = {
      ...pendingApproval,
      status: 'RESOLVED',
      decision: { type: 'approve' },
      decidedById: 'user-1',
      decidedAt: new Date('2026-08-16T00:00:00.000Z'),
    };
    findUnique
      .mockResolvedValueOnce(pendingApproval)
      .mockResolvedValueOnce(resolvedApproval);
    updateMany.mockResolvedValue({ count: 1 });

    const first = await service.decide({
      taskId: 'task-1',
      approvalId: 'approval-1',
      actorId: 'user-1',
      decision: { type: 'approve' },
    });
    const repeated = await service.decide({
      taskId: 'task-1',
      approvalId: 'approval-1',
      actorId: 'user-1',
      decision: { type: 'approve' },
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'approval-1',
        taskId: 'task-1',
        status: 'PENDING',
      },
      data: {
        status: 'RESOLVED',
        decision: { type: 'approve' },
        decidedAt: expect.any(Date),
        decidedById: 'user-1',
      },
    });
    expect(first).toMatchObject({
      id: 'approval-1',
      status: 'RESOLVED',
      decision: { type: 'approve' },
    });
    expect(repeated).toEqual(resolvedApproval);
  });

  it('重复提交不同决定时返回冲突且不覆盖首次决定', async () => {
    findUnique.mockResolvedValue({
      id: 'approval-1',
      taskId: 'task-1',
      status: 'RESOLVED',
      decision: { type: 'reject', reason: '风险过高' },
      decidedAt: new Date('2026-08-16T00:00:00.000Z'),
      decidedById: 'user-1',
    });

    await expect(
      service.decide({
        taskId: 'task-1',
        approvalId: 'approval-1',
        actorId: 'user-1',
        decision: { type: 'approve' },
      }),
    ).rejects.toThrow(new ConflictException('审批已处理，不能提交不同决定'));

    expect(updateMany).not.toHaveBeenCalled();
  });
});
