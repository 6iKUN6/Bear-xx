import {
  AgentFlowApprovalKind,
  AgentFlowApprovalStatus,
  StreamTaskStatus,
} from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { StreamTaskEventType } from '@litter-bear/types/protocol';
import { AgentFlowApprovalService } from './agent-flow-approval.service';

describe('AgentFlowApprovalService · Flow 审批', () => {
  it('首次决定在同一事务中收敛 trace、写恢复事件与 Signal outbox', async () => {
    const transaction = {
      agentFlowApproval: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'approval-1',
          taskId: 'task-1',
          runId: 'run-1',
          traceItemId: 'trace-1',
          nodeKey: 'review',
          kind: 'PLAN_REVIEW',
          status: AgentFlowApprovalStatus.PENDING,
          decision: null,
          task: {
            id: 'task-1',
            userId: 'user-1',
            conversationId: 'conversation-1',
            messageId: 'message-1',
            currentRunId: 'run-1',
            flowVersionId: 'version-1',
          },
          run: { sequence: 1 },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversationTurnTraceItem: {
        update: jest.fn(),
      },
      agentFlowSignalOutbox: {
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation((operation: (tx: typeof transaction) => unknown) =>
          operation(transaction),
        ),
    };
    const eventService = {
      persistInTransaction: jest.fn().mockResolvedValue({
        taskId: 'task-1',
        eventId: 9,
        eventName: StreamTaskEventType.FlowRunResumed,
        data: '{"type":"flow.run.resumed"}',
      }),
      publishAfterCommit: jest.fn(),
    };
    const service = new AgentFlowApprovalService(
      prisma as never,
      eventService as never,
    );

    const result = await service.decideAndQueueSignal({
      taskId: 'task-1',
      approvalId: 'approval-1',
      actorId: 'user-1',
      kind: 'PLAN_REVIEW',
      decision: { decision: 'approve' },
    });

    expect(result).toMatchObject({
      id: 'approval-1',
      status: AgentFlowApprovalStatus.RESOLVED,
      decision: { decision: 'approve' },
    });
    expect(transaction.agentFlowApproval.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'approval-1',
        taskId: 'task-1',
        status: AgentFlowApprovalStatus.PENDING,
      },
      data: expect.objectContaining({
        status: AgentFlowApprovalStatus.RESOLVED,
        decidedById: 'user-1',
      }),
    });
    expect(transaction.conversationTurnTraceItem.update).toHaveBeenCalledWith({
      where: { id: 'trace-1' },
      data: expect.objectContaining({ status: 'SUCCESS' }),
    });
    expect(eventService.persistInTransaction).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        eventName: StreamTaskEventType.FlowRunResumed,
        status: StreamTaskStatus.WAITING_HUMAN,
        payload: { runSequence: 1, reason: 'approval' },
      }),
    );
    expect(transaction.agentFlowSignalOutbox.create).toHaveBeenCalledWith({
      data: {
        taskId: 'task-1',
        approvalId: 'approval-1',
        createdById: 'user-1',
      },
    });
    expect(eventService.publishAfterCommit).toHaveBeenCalledWith({
      taskId: 'task-1',
      eventId: 9,
      eventName: StreamTaskEventType.FlowRunResumed,
      data: '{"type":"flow.run.resumed"}',
    });
  });

  it('拒绝绕过客户端卡片提交多工具批次不允许的 edit 决定', async () => {
    const transaction = {
      agentFlowApproval: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'approval-batch-1',
          taskId: 'task-1',
          runId: 'run-1',
          traceItemId: 'trace-1',
          nodeKey: 'execute',
          kind: AgentFlowApprovalKind.TOOL,
          status: AgentFlowApprovalStatus.PENDING,
          requestSummary: {
            requests: [
              { toolName: 'create-order', index: 0 },
              { toolName: 'cancel-order', index: 1 },
            ],
            allowedDecisions: ['approve', 'reject'],
          },
          decision: null,
          task: {
            id: 'task-1',
            userId: 'user-1',
            conversationId: 'conversation-1',
            messageId: 'message-1',
            currentRunId: 'run-1',
            flowVersionId: 'version-1',
          },
          run: { sequence: 1 },
        }),
        updateMany: jest.fn(),
      },
      conversationTurnTraceItem: { update: jest.fn() },
      agentFlowSignalOutbox: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation((operation: (tx: typeof transaction) => unknown) =>
          operation(transaction),
        ),
    };
    const service = new AgentFlowApprovalService(
      prisma as never,
      {
        persistInTransaction: jest.fn(),
        publishAfterCommit: jest.fn(),
      } as never,
    );

    await expect(
      service.decideAndQueueSignal({
        taskId: 'task-1',
        approvalId: 'approval-batch-1',
        actorId: 'user-1',
        kind: AgentFlowApprovalKind.TOOL,
        decision: { decision: 'edit', editedArgs: { item: 'cola' } },
      }),
    ).rejects.toThrow(new BadRequestException('当前审批不允许该决定'));

    expect(transaction.agentFlowApproval.updateMany).not.toHaveBeenCalled();
    expect(transaction.agentFlowSignalOutbox.create).not.toHaveBeenCalled();
  });
});
