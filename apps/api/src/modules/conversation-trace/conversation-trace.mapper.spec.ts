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
