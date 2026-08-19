import { StreamTaskEventType } from '../stream-task/stream-task-event.types';
import { mapStreamEventToTraceCommand } from './conversation-trace.mapper';
import { ConversationTraceItemType } from './conversation-trace.types';

/**
 * 回答者指派事件 → trace item 的映射
 * @description 指派信息此前只在 task.created（合成事件、不入持久化流）里，
 * 刷新即失。这里覆盖落 trace 的形状与各来源的 summary 兜底。
 */
describe('mapStreamEventToTraceCommand · agent.routed', () => {
  // eventName 放在每个用例里而非 baseInput：写进共享对象会被推断成
  // StreamTaskEventType 整体，判别联合就收窄不到具体载荷
  const baseInput = {
    userId: 'user-1',
    taskId: 'task-1',
    streamId: 'run-1',
    conversationId: 'conversation-1',
    messageId: 'message-1',
    eventName: StreamTaskEventType.AgentRouted as const,
  };

  it('自动路由：落 AGENT_ROUTING，summary 用模型给的理由', () => {
    const command = mapStreamEventToTraceCommand({
      ...baseInput,
      payload: {
        agentId: 'agent-painter',
        agentName: '画师一号',
        source: 'model',
        reason: '用户要画图',
      },
    });

    expect(command).toMatchObject({
      action: 'create-success',
      input: {
        type: ConversationTraceItemType.AGENT_ROUTING,
        title: '指派回答者',
        summary: '用户要画图',
        traceKey: 'agent:routed',
      },
    });
  });

  it('降级：无理由时 summary 明确指出自动分配未生效', () => {
    const command = mapStreamEventToTraceCommand({
      ...baseInput,
      payload: { agentId: 'agent-a', source: 'fallback' },
    });

    expect(command?.input).toMatchObject({
      summary: '自动分配不可用，已交给首位成员',
    });
  });

  it('用户 @ 指定：summary 说明来源而非留空', () => {
    const command = mapStreamEventToTraceCommand({
      ...baseInput,
      payload: { agentId: 'agent-a', source: 'explicit' },
    });

    expect(command?.input).toMatchObject({ summary: '用户指定回答者' });
  });

  it('metadata 保留原始 payload，供前端回显名称与来源', () => {
    const command = mapStreamEventToTraceCommand({
      ...baseInput,
      payload: {
        agentId: 'agent-painter',
        agentName: '画师一号',
        source: 'model',
      },
    });

    expect(command?.input.metadata).toMatchObject({
      agentId: 'agent-painter',
      agentName: '画师一号',
      source: 'model',
    });
  });
});

/**
 * 审批事件 → trace item 的映射
 * @description 此前 approval.required 没有对应分支（映射直接返回 null），
 * trace 上完全看不出这条消息经过人工确认；批复后也无事件，永远停在等待态。
 * 这里覆盖「请求开一条 RUNNING、结果收敛同一条」的配对形状。
 */
describe('mapStreamEventToTraceCommand · 审批', () => {
  const baseInput = {
    userId: 'user-1',
    taskId: 'task-1',
    streamId: 'run-1',
    conversationId: 'conversation-1',
    messageId: 'message-1',
  };

  it('待审批：开一条 RUNNING 的 APPROVAL 项', () => {
    const command = mapStreamEventToTraceCommand({
      ...baseInput,
      eventName: StreamTaskEventType.ApprovalRequired,
      payload: {
        toolName: 'createOrder',
        description: '将下单并支付 32 元',
        allowedDecisions: ['approve', 'reject'],
        index: 0,
        nodeKey: 'common_chat_approval',
        traceKey: 'approval:createOrder:0',
        publicStatus: '待人工确认',
      },
    });

    expect(command).toMatchObject({
      action: 'start',
      input: {
        type: ConversationTraceItemType.APPROVAL,
        title: '待人工确认：createOrder',
        summary: '将下单并支付 32 元',
        traceKey: 'approval:createOrder:0',
        toolName: 'createOrder',
      },
    });
  });

  it('已批复：complete 同一个 traceKey，summary 用决定文案', () => {
    const command = mapStreamEventToTraceCommand({
      ...baseInput,
      eventName: StreamTaskEventType.ApprovalResolved,
      payload: {
        decision: 'approve',
        decidedBy: 'user-1',
        toolName: 'createOrder',
        nodeKey: 'common_chat_approval',
        traceKey: 'approval:createOrder:0',
        publicStatus: '已通过',
      },
    });

    expect(command).toMatchObject({
      action: 'complete',
      input: {
        traceKey: 'approval:createOrder:0',
        title: '人工确认：createOrder',
        summary: '已通过',
      },
    });
  });

  it('拒绝：决定与决定人进 metadata，可审计', () => {
    const command = mapStreamEventToTraceCommand({
      ...baseInput,
      eventName: StreamTaskEventType.ApprovalResolved,
      payload: {
        decision: 'reject',
        decidedBy: 'user-9',
        reason: '金额不对',
        nodeKey: 'common_chat_approval',
        traceKey: 'approval:createOrder:0',
        publicStatus: '已拒绝',
      },
    });

    expect(command?.input).toMatchObject({ summary: '已拒绝' });
    expect(command?.input.metadata).toMatchObject({
      decision: 'reject',
      decidedBy: 'user-9',
      reason: '金额不对',
    });
  });
});

describe('mapStreamEventToTraceCommand · AgentFlow', () => {
  const baseInput = {
    userId: 'user-1',
    taskId: 'task-1',
    streamId: 'run-1',
    conversationId: 'conversation-1',
    messageId: 'message-1',
  };

  it('Flow 节点开始和完成使用同一 traceKey 收敛为一个工作流节点', () => {
    const started = mapStreamEventToTraceCommand({
      ...baseInput,
      eventName: StreamTaskEventType.FlowNodeStarted,
      payload: {
        nodeKey: 'answer',
        nodeType: 'agent',
        title: '生成回复',
        traceKey: 'flow:answer',
      },
    });
    const completed = mapStreamEventToTraceCommand({
      ...baseInput,
      eventName: StreamTaskEventType.FlowNodeCompleted,
      payload: {
        nodeKey: 'answer',
        nodeType: 'agent',
        traceKey: 'flow:answer',
        summary: '已生成回复',
        durationMs: 120,
      },
    });

    expect(started).toMatchObject({
      action: 'start',
      input: {
        type: ConversationTraceItemType.WORKFLOW_STEP,
        nodeKey: 'answer',
        traceKey: 'flow:answer',
        title: '生成回复',
      },
    });
    expect(completed).toMatchObject({
      action: 'complete',
      input: {
        nodeKey: 'answer',
        traceKey: 'flow:answer',
        summary: '已生成回复',
        metrics: { durationMs: 120 },
      },
    });
  });

  it('flow.waiting_human 创建可收敛的审批轨迹，保留 approvalId', () => {
    const command = mapStreamEventToTraceCommand({
      ...baseInput,
      eventName: StreamTaskEventType.FlowWaitingHuman,
      payload: {
        approvalId: 'approval-1',
        nodeKey: 'review',
        traceKey: 'flow:review:approval',
        approval: {
          kind: 'plan-review',
          steps: [{ id: 'step-1', goal: '核对订单' }],
          revision: 1,
          allowedDecisions: [
            'approve',
            'edit',
            'reject_replan',
            'reject_terminate',
          ],
        },
        expiresAt: '2026-08-18T09:00:00.000Z',
      },
    });

    expect(command).toMatchObject({
      action: 'start',
      input: {
        type: ConversationTraceItemType.APPROVAL,
        nodeKey: 'review',
        traceKey: 'flow:review:approval',
        title: '待确认计划',
        summary: '共 1 步待确认',
        metadata: expect.objectContaining({ approvalId: 'approval-1' }),
      },
    });
  });

  it('flow.waiting_human 将同一轮工具审批聚合为一条批次轨迹', () => {
    const command = mapStreamEventToTraceCommand({
      ...baseInput,
      eventName: StreamTaskEventType.FlowWaitingHuman,
      payload: {
        approvalId: 'approval-batch-1',
        nodeKey: 'execute',
        traceKey: 'flow:execute:approval',
        approval: {
          kind: 'tool',
          requests: [
            {
              toolName: 'create-order',
              description: '创建订单',
              index: 0,
            },
            {
              toolName: 'cancel-order',
              description: '取消订单',
              index: 1,
            },
          ],
          allowedDecisions: ['approve', 'reject'],
        },
        expiresAt: '2026-08-18T09:00:00.000Z',
      },
    });

    expect(command).toMatchObject({
      action: 'start',
      input: {
        type: ConversationTraceItemType.APPROVAL,
        nodeKey: 'execute',
        traceKey: 'flow:execute:approval',
        title: '待人工确认：create-order等 2 个工具',
        summary: '创建订单；取消订单',
        toolName: 'create-order',
      },
    });
  });
});
