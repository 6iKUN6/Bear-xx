import { ConfigService } from '@nestjs/config';
import { MembershipTier, StreamTaskStatus } from '@prisma/client';
import { StreamTaskEventType } from '@litter-bear/types/protocol';
import { StreamTaskService } from './stream-task.service';
import { runWithMcDonaldsOrderContext } from '../mcdonalds-order/mcdonalds-order-context';
import {
  AgentAccessDenialReason,
  AgentAccessService,
} from '../agent-access/agent-access.service';

describe('StreamTaskService', () => {
  function createService() {
    const prisma = {
      streamTask: {
        update: jest.fn().mockResolvedValue({ lastEventId: 2 }),
        findUnique: jest.fn(),
      },
      streamTaskEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const registry = { publish: jest.fn() };
    const snapshotService = {
      appendFrame: jest
        .fn()
        .mockResolvedValue({ id: '1-0', event: 'order.created', data: '{}' }),
    };
    const mcdonaldsOrderService = {
      getCardsByIds: jest.fn().mockResolvedValue([]),
    };
    const capabilityRegistry = { getToolMetadata: jest.fn() };
    const flowApprovalService = {
      decideAndQueueSignal: jest.fn(),
    };
    const flowSignalOutboxService = {
      dispatchPending: jest.fn(),
    };

    const service = new StreamTaskService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new ConfigService({ STREAM_TASK_BUFFER_TTL: 300 }),
      {} as never,
      {} as never,
      { recordStreamEvent: jest.fn() } as never,
      {} as never,
      {} as never,
      registry as never,
      snapshotService as never,
      mcdonaldsOrderService as never,
      capabilityRegistry as never,
      {} as never,
      {} as never,
      flowApprovalService as never,
      flowSignalOutboxService as never,
      new AgentAccessService(),
    );

    return {
      service,
      prisma,
      mcdonaldsOrderService,
      snapshotService,
      capabilityRegistry,
      flowApprovalService,
      flowSignalOutboxService,
    };
  }

  it('不会把其他 MCP 的 create-order 当作麦当劳订单创建事件', async () => {
    const { service, mcdonaldsOrderService } = createService();

    await runWithMcDonaldsOrderContext('task-1', 'user-1', async () => {
      const context =
        await import('../mcdonalds-order/mcdonalds-order-context');
      context.registerCreatedMcDonaldsOrder('order-1');
      await service['handleAgentLoopStatusEvent'](
        {
          id: 'task-1',
          userId: 'user-1',
          streamId: 'stream-1',
          conversationId: 'conversation-1',
          messageId: 'message-1',
        },
        {
          type: StreamTaskEventType.ToolCallDone,
          payload: {
            name: 'other-mcp__create-order',
            toolName: 'other-mcp__create-order',
            summary: '创建订单完成',
            index: 0,
          },
        },
      );
    });

    expect(mcdonaldsOrderService.getCardsByIds).not.toHaveBeenCalled();
  });

  it('普通用户创建任务时拒绝停用和会员等级不足的智能体', async () => {
    const { service } = createService();
    const agentFindUnique = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'agent-1',
        enabled: false,
        minimumMembershipTier: MembershipTier.FREE,
      })
      .mockResolvedValueOnce({
        id: 'agent-1',
        enabled: true,
        minimumMembershipTier: MembershipTier.PRO,
      });
    const tx = {
      agent: { findUnique: agentFindUnique },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          membershipTier: MembershipTier.FREE,
          membershipExpiresAt: null,
        }),
      },
    };

    await expect(
      service['enforceAgentAccess'](tx as never, 'user-1', 'agent-1', false),
    ).rejects.toMatchObject({
      response: { code: AgentAccessDenialReason.Disabled },
    });
    await expect(
      service['enforceAgentAccess'](tx as never, 'user-1', 'agent-1', false),
    ).rejects.toMatchObject({
      response: { code: AgentAccessDenialReason.MembershipRequired },
    });
  });

  it('Admin 调试绕过会员门槛，但仍拒绝停用的智能体', async () => {
    const { service } = createService();
    const userFindUnique = jest.fn();
    const tx = {
      agent: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'agent-1',
            enabled: true,
            minimumMembershipTier: MembershipTier.PRO,
          })
          .mockResolvedValueOnce({
            id: 'agent-1',
            enabled: false,
            minimumMembershipTier: MembershipTier.FREE,
          }),
      },
      user: { findUnique: userFindUnique },
    };

    await expect(
      service['enforceAgentAccess'](tx as never, 'admin-1', 'agent-1', true),
    ).resolves.toBeUndefined();
    await expect(
      service['enforceAgentAccess'](tx as never, 'admin-1', 'agent-1', true),
    ).rejects.toThrow('停用的智能体不可调试');
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it('麦当劳下单完成后只发布安全的订单卡片', async () => {
    const {
      service,
      mcdonaldsOrderService,
      snapshotService,
      capabilityRegistry,
    } = createService();
    capabilityRegistry.getToolMetadata.mockReturnValue({
      mcpServer: 'mcdonalds',
      mcpTool: 'create-order',
    });
    mcdonaldsOrderService.getCardsByIds.mockResolvedValue([
      {
        id: 'order-1',
        externalOrderId: 'external-1',
        status: 'UNPAID',
        statusLabel: '待支付',
        storeName: '人民广场店',
        fulfillmentType: '到店取餐',
        totalAmount: '24.50',
        discountAmount: null,
        currency: 'CNY',
        items: [],
        estimatedFulfillmentAt: null,
        lastRefreshedAt: null,
        createdAt: '2026-08-12T10:00:00.000Z',
      },
    ]);

    await runWithMcDonaldsOrderContext('task-1', 'user-1', async () => {
      const context =
        await import('../mcdonalds-order/mcdonalds-order-context');
      context.registerCreatedMcDonaldsOrder('order-1');
      await service['handleAgentLoopStatusEvent'](
        {
          id: 'task-1',
          userId: 'user-1',
          streamId: 'stream-1',
          conversationId: 'conversation-1',
          messageId: 'message-1',
        },
        {
          type: StreamTaskEventType.ToolCallDone,
          payload: {
            name: 'mcdonalds__create-order',
            toolName: 'mcdonalds__create-order',
            summary: '创建订单完成',
            index: 0,
          },
        },
      );
    });

    expect(mcdonaldsOrderService.getCardsByIds).toHaveBeenCalledWith(
      ['order-1'],
      'user-1',
    );
    const orderCreatedCall = snapshotService.appendFrame.mock.calls.find(
      (call) => call[1] === StreamTaskEventType.OrderCreated,
    );
    expect(orderCreatedCall).toBeDefined();
    expect(orderCreatedCall?.[2]).toEqual(
      expect.stringContaining('"order":{"id":"order-1"'),
    );
    expect(orderCreatedCall?.[2]).not.toContain('paymentUrl');
  });

  it('优先记录任务聚合的供应商 token usage，并区分摘要与供应商缓存', () => {
    const { service } = createService();

    const metrics = service['buildChatRunMetrics'](
      [{ role: 'user', content: '请帮我查询订单' }],
      '已为你查询完成。',
      {
        messages: [{ role: 'user', content: '请帮我查询订单' }],
        summary: {
          content: '用户曾查询过订单。',
          messageCount: 6,
        },
        recentWindow: { limit: 12, messageCount: 3 },
      },
      320,
      {
        inputTokens: 300,
        outputTokens: 80,
        totalTokens: 380,
        cachedInputTokens: 240,
        reasoningTokens: 30,
        estimated: false,
      },
    );

    expect(metrics).toEqual({
      tokenUsage: {
        inputTokens: 300,
        outputTokens: 80,
        totalTokens: 380,
        cachedInputTokens: 240,
        reasoningTokens: 30,
        estimated: false,
      },
      cache: {
        memorySummaryHit: true,
        providerPromptCacheHit: true,
        contextCacheHit: true,
        cachedInputTokens: 240,
      },
      durationMs: 320,
      messageCount: 1,
      summaryMessageCount: 6,
      recentMessageCount: 3,
    });
  });

  it('跨审批恢复时累加已暂停执行段的模型用量', () => {
    const { service } = createService();

    const metrics = service['mergeModelRunMetrics'](
      {
        modelCallCount: 1,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cachedInputTokens: 40,
          estimated: false,
        },
      },
      {
        modelCallCount: 1,
        tokenUsage: {
          inputTokens: 30,
          outputTokens: 10,
          totalTokens: 40,
          cachedInputTokens: 0,
          estimated: true,
        },
      },
    );

    expect(metrics).toEqual({
      modelCallCount: 2,
      tokenUsage: {
        inputTokens: 130,
        outputTokens: 30,
        totalTokens: 160,
        cachedInputTokens: 40,
        estimated: true,
      },
    });
  });

  it('已锁定 Flow 的任务要求 approvalId，并改由数据库事实和 outbox 恢复', async () => {
    const { service, prisma, flowApprovalService, flowSignalOutboxService } =
      createService();
    prisma.streamTask.findUnique.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      status: StreamTaskStatus.WAITING_HUMAN,
      flowVersionId: 'version-1',
    });

    const result = await service.resumeTaskWithDecision(
      'task-1',
      'user-1',
      { decision: 'approve' },
      '0',
      undefined,
      'approval-1',
    );

    expect(result).toHaveProperty('stream');
    expect(flowApprovalService.decideAndQueueSignal).toHaveBeenCalledWith({
      taskId: 'task-1',
      approvalId: 'approval-1',
      actorId: 'user-1',
      kind: 'TOOL',
      decision: { decision: 'approve' },
    });
    expect(flowSignalOutboxService.dispatchPending).toHaveBeenCalledTimes(1);
  });
});
