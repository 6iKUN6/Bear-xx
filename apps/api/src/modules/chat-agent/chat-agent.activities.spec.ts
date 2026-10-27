import { StreamTaskEventType } from '@litter-bear/types/protocol';
import { Test, type TestingModule } from '@nestjs/testing';
import { StreamTaskRuntime, StreamTaskStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentFlowTaskEventService } from '../agent-flow/agent-flow-task-event.service';
import { AgentRunSupport } from '../agent-flow/runtime/agent-run.support';
import { FlowContextService } from '../agent-flow/runtime/flow-context.service';
import { CapabilityResolver } from '../ai/agent-loop/capability/capability.resolver';
import { CommonChatAgentService } from '../ai/agents';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import { ChatContextService } from '../memory/chat-context.service';
import { StorageAssetService } from '../storage/storage-asset.service';
import { ChatAgentActivities } from './chat-agent.activities';
import { DefaultChatAgent } from './default-chat.agent';

const WORKFLOW = {
  streamTaskId: 'task-1',
  activityTaskQueue: 'agent-flow-activity',
};

describe('ChatAgentActivities', () => {
  let activities: ChatAgentActivities;
  const prisma = {
    streamTask: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    agent: { findUnique: jest.fn() },
    agentFlowNodeExecution: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    agentFlowNodeContext: { findUnique: jest.fn(), upsert: jest.fn() },
    agentFlowApproval: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    message: { update: jest.fn() },
    $transaction: jest.fn(),
  };
  const capabilityResolver = { resolve: jest.fn() };
  const chatContextService = { buildContextBundle: jest.fn() };
  const commonChatAgentService = {
    streamEvents: jest.fn(),
    resumeEvents: jest.fn(),
  };
  const modelRegistry = {
    invalidate: jest.fn(),
    getVisionTransport: jest.fn(),
    getContextLimits: jest.fn((preset?: string) => ({
      modelPreset: preset ?? 'preset-default',
      contextWindowTokens: 128000,
      maxOutputTokens: 4096,
    })),
    resolveTextRequest: jest.fn(() => ({
      model: { id: 'model-1', platform: 'openai', model: 'test-model' },
      generation: {},
    })),
  };
  const taskEventService = {
    persistInTransaction: jest.fn(),
    publishAfterCommit: jest.fn(),
    publishTransient: jest.fn(),
    markCompletedAfterCommit: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (operation: (transaction: typeof prisma) => unknown) => operation(prisma),
    );
    prisma.streamTask.findUnique.mockResolvedValue(chatTask());
    prisma.streamTask.update.mockResolvedValue({
      flowModelCalls: 1,
      flowToolCalls: 0,
    });
    prisma.streamTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.agent.findUnique.mockResolvedValue({ systemPrompt: '你是小熊' });
    prisma.agentFlowNodeExecution.findUnique.mockResolvedValue(null);
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([]);
    prisma.agentFlowNodeContext.findUnique.mockResolvedValue(null);
    prisma.agentFlowNodeContext.upsert.mockImplementation(
      ({ create }: { create: unknown }) => Promise.resolve(create),
    );
    prisma.agentFlowApproval.findFirst.mockResolvedValue(null);
    modelRegistry.invalidate.mockResolvedValue(undefined);
    chatContextService.buildContextBundle.mockResolvedValue({
      messageIds: [],
      messages: [{ role: 'user', content: '深圳天气' }],
    });
    capabilityResolver.resolve.mockResolvedValue({
      tools: [{ name: 'getWeather' }],
      systemPromptAdditions: ['可以查询天气'],
      subagentTools: [],
      approvalToolNames: [],
    });
    taskEventService.persistInTransaction.mockResolvedValue({
      taskId: 'task-1',
      eventId: 1,
      eventName: 'flow.node.started',
      data: '{}',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatAgentActivities,
        DefaultChatAgent,
        AgentRunSupport,
        FlowContextService,
        { provide: PrismaService, useValue: prisma },
        { provide: CapabilityResolver, useValue: capabilityResolver },
        { provide: ChatContextService, useValue: chatContextService },
        { provide: CommonChatAgentService, useValue: commonChatAgentService },
        { provide: AgentFlowTaskEventService, useValue: taskEventService },
        { provide: LlmModelRegistryService, useValue: modelRegistry },
        {
          provide: StorageAssetService,
          useValue: { prepareChatImageForModel: jest.fn() },
        },
      ],
    }).compile();
    activities = module.get(ChatAgentActivities);
  });

  it('按锁定的工具组装配 ReAct 智能体，推送正文与工具轨迹后落库完成', async () => {
    commonChatAgentService.streamEvents.mockReturnValue(toolRoundTripStream());

    await expect(
      activities.runChatAgent({ workflow: WORKFLOW }),
    ).resolves.toEqual({ kind: 'completed' });

    expect(capabilityResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ toolGroups: ['weather'], skills: [] }),
      'user-1',
    );
    expect(commonChatAgentService.streamEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPreset: 'model-1',
        systemPrompt: '你是小熊\n\n可以查询天气',
        tools: [{ name: 'getWeather' }],
        threadId: 'task-1:chat#0',
        maxToolIterations: 8,
      }),
    );
    expect(eventNames()).toEqual([
      StreamTaskEventType.FlowNodeStarted,
      StreamTaskEventType.ModelCallStart,
      StreamTaskEventType.ToolCallStart,
      StreamTaskEventType.ToolCallDone,
      StreamTaskEventType.ModelCallDone,
      StreamTaskEventType.FlowNodeCompleted,
    ]);
    expect(taskEventService.publishTransient).toHaveBeenCalledWith(
      'task-1',
      StreamTaskEventType.MessageDelta,
      expect.stringContaining('深圳晴'),
    );
    expect(prisma.agentFlowNodeExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        nodeExecutionId: 'task-1:chat#0',
        nodeKey: 'chat',
        result: 'COMPLETED',
        summary: '已生成回复',
      }),
    });
    expect(completedEvent()).toMatchObject({
      taskUpdate: expect.objectContaining({ fullContent: '深圳晴' }),
    });
  });

  it('模型能力降级的任务在节点摘要里说明本轮未启用工具', async () => {
    prisma.streamTask.findUnique.mockResolvedValue(
      chatTask({ resolvedAgentToolGroups: [], agentToolsDegraded: true }),
    );
    capabilityResolver.resolve.mockResolvedValue({
      tools: [],
      systemPromptAdditions: [],
      subagentTools: [],
      approvalToolNames: [],
    });
    commonChatAgentService.streamEvents.mockReturnValue(
      textEventStream('你好'),
    );

    await activities.runChatAgent({ workflow: WORKFLOW });

    expect(completedEvent()).toMatchObject({
      payload: expect.objectContaining({
        summary: '已生成回复（当前模型未通过工具探测，本轮未启用工具）',
      }),
    });
  });

  it('工具需要审批时持久化等待事实并交还 Workflow', async () => {
    commonChatAgentService.streamEvents.mockReturnValue(approvalEventStream());
    prisma.agentFlowApproval.create.mockResolvedValue({ id: 'approval-1' });

    await expect(
      activities.runChatAgent({ workflow: WORKFLOW }),
    ).resolves.toEqual({
      kind: 'waiting_human',
      approvalId: 'approval-1',
      timeoutSeconds: 900,
    });
    expect(prisma.agentFlowApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ nodeKey: 'chat', kind: 'TOOL' }),
    });
    expect(prisma.agentFlowNodeExecution.create).not.toHaveBeenCalled();
  });

  it('审批通过后用同一 thread 与上下文快照恢复', async () => {
    prisma.agentFlowApproval.findUnique.mockResolvedValue({
      taskId: 'task-1',
      nodeKey: 'chat',
      kind: 'TOOL',
      status: 'RESOLVED',
      decision: { decision: 'approve' },
    });
    commonChatAgentService.resumeEvents.mockReturnValue(
      textEventStream('图已生成'),
    );

    await expect(
      activities.resumeChatAgent({
        workflow: WORKFLOW,
        approvalId: 'approval-1',
      }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(commonChatAgentService.resumeEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'task-1:chat#0',
        decision: { decision: 'approve' },
      }),
    );
    // 恢复不重发节点开始事件
    expect(eventNames()).not.toContain(StreamTaskEventType.FlowNodeStarted);
  });

  it('拒绝不属于本任务 chat 节点的审批决定', async () => {
    prisma.agentFlowApproval.findUnique.mockResolvedValue({
      taskId: 'task-1',
      nodeKey: 'other',
      kind: 'TOOL',
      status: 'RESOLVED',
      decision: { decision: 'approve' },
    });

    await expect(
      activities.resumeChatAgent({
        workflow: WORKFLOW,
        approvalId: 'approval-1',
      }),
    ).rejects.toThrow('审批决定不存在或尚未完成');
    expect(commonChatAgentService.resumeEvents).not.toHaveBeenCalled();
  });

  it('已有完成记录时直接回放，不再调用模型', async () => {
    prisma.agentFlowNodeExecution.findUnique.mockResolvedValue({
      result: 'COMPLETED',
      errorCategory: null,
    });

    await expect(
      activities.runChatAgent({ workflow: WORKFLOW }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(commonChatAgentService.streamEvents).not.toHaveBeenCalled();
    expect(taskEventService.persistInTransaction).not.toHaveBeenCalled();
  });

  it('任务已被取消时不再调用模型', async () => {
    prisma.streamTask.findUnique.mockResolvedValue(
      chatTask({ status: StreamTaskStatus.CANCELED }),
    );

    await expect(
      activities.runChatAgent({ workflow: WORKFLOW }),
    ).resolves.toEqual({ kind: 'stopped', status: 'cancelled' });
    expect(commonChatAgentService.streamEvents).not.toHaveBeenCalled();
  });

  it('模型调用额度已用尽时直接按预算停止', async () => {
    prisma.streamTask.findUnique.mockResolvedValue(
      chatTask({ flowModelCalls: 24 }),
    );

    await expect(
      activities.runChatAgent({ workflow: WORKFLOW }),
    ).resolves.toEqual({
      kind: 'stopped',
      status: 'error',
      errorCategory: 'budget_exceeded',
    });
    expect(commonChatAgentService.streamEvents).not.toHaveBeenCalled();
    expect(eventNames()).toContain(StreamTaskEventType.FlowNodeFailed);
  });

  it('拒绝不是默认智能体运行时的任务', async () => {
    prisma.streamTask.findUnique.mockResolvedValue(
      chatTask({ runtime: StreamTaskRuntime.AGENT_FLOW }),
    );

    await expect(
      activities.runChatAgent({ workflow: WORKFLOW }),
    ).rejects.toThrow('默认智能体任务上下文不完整或快照不一致');
  });

  /** 按顺序列出已持久化事件的名称。 */
  function eventNames(): StreamTaskEventType[] {
    return (
      taskEventService.persistInTransaction.mock.calls as Array<
        [unknown, { eventName: StreamTaskEventType }]
      >
    ).map(([, event]) => event.eventName);
  }

  /** 取出节点完成事件的持久化入参。 */
  function completedEvent(): unknown {
    return (
      taskEventService.persistInTransaction.mock.calls as Array<
        [unknown, { eventName: StreamTaskEventType }]
      >
    ).find(
      ([, event]) => event.eventName === StreamTaskEventType.FlowNodeCompleted,
    )?.[1];
  }
});

/** 构造一条已锁定快照的默认智能体任务。 */
function chatTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    userId: 'user-1',
    status: StreamTaskStatus.STREAMING,
    runtime: StreamTaskRuntime.CHAT_AGENT,
    conversationId: 'conversation-1',
    messageId: 'message-1',
    currentRunId: 'run-1',
    agentId: 'agent-1',
    fullContent: '',
    flowModelCalls: 0,
    flowToolCalls: 0,
    requestPayload: { content: '深圳天气' },
    resolvedAgentModelPresetId: 'model-1',
    resolvedAgentReasoningConfig: null,
    resolvedAgentToolGroups: ['weather'],
    agentToolsDegraded: false,
    ...overrides,
  };
}

/** 只输出一段正文的底层智能体流。 */
async function* textEventStream(delta: string) {
  await Promise.resolve();
  yield { type: StreamTaskEventType.MessageDelta, delta };
}

/** 一次完整工具往返后给出回答的底层智能体流。 */
async function* toolRoundTripStream() {
  await Promise.resolve();
  const tool = {
    toolCallId: 'call-1',
    name: 'getWeather',
    toolName: 'getWeather',
    index: 0,
    nodeKey: 'common_chat_tool',
    traceKey: 'tool:call-1',
  };
  yield { type: StreamTaskEventType.ToolCallStart, payload: tool };
  yield {
    type: StreamTaskEventType.ToolCallDone,
    payload: { ...tool, summary: '已使用 getWeather' },
  };
  yield { type: StreamTaskEventType.MessageDelta, delta: '深圳晴' };
}

/** 产出一次工具审批请求的底层智能体流。 */
async function* approvalEventStream() {
  await Promise.resolve();
  yield {
    type: StreamTaskEventType.ApprovalRequired,
    payload: {
      toolName: 'generateImage',
      allowedDecisions: ['approve', 'reject'],
      index: 0,
    },
  };
}
