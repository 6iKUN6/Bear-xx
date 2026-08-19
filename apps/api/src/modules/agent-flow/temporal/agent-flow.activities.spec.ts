import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AgentFlowWorkflowInput } from '../../../temporal/workflows/agent-flow.workflow.types';
import { FlowCompiler } from '../runtime/flow-compiler.service';
import { CapabilityResolver } from '../../ai/agent-loop/capability/capability.resolver';
import { ChatContextService } from '../../memory/chat-context.service';
import { CommonChatAgentService } from '../../ai/agents';
import { AgentFlowTaskEventService } from '../agent-flow-task-event.service';
import { PlannerService } from '../../ai/agent-loop/execution/planner.service';
import { STEP_EVALUATOR } from '../../ai/agent-loop/execution/step-evaluator';
import { AgentFlowActivities } from './agent-flow.activities';

describe('AgentFlowActivities', () => {
  let activities: AgentFlowActivities;
  const prisma = {
    streamTask: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    agent: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
    agentFlowApproval: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    conversationTurnTraceItem: {
      updateMany: jest.fn(),
    },
    message: {
      update: jest.fn(),
    },
    streamTaskRun: {
      update: jest.fn(),
    },
  };
  const flowCompiler = { compile: jest.fn() };
  const capabilityResolver = { resolve: jest.fn() };
  const chatContextService = { buildContextBundle: jest.fn() };
  const commonChatAgentService = {
    streamEvents: jest.fn(),
    resumeEvents: jest.fn(),
  };
  const planner = { plan: jest.fn() };
  const stepEvaluator = { enough: jest.fn() };
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
    taskEventService.persistInTransaction.mockResolvedValue({
      taskId: 'task-1',
      eventId: 1,
      eventName: 'flow.node.started',
      data: '{}',
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentFlowActivities,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        { provide: FlowCompiler, useValue: flowCompiler },
        { provide: CapabilityResolver, useValue: capabilityResolver },
        { provide: ChatContextService, useValue: chatContextService },
        { provide: CommonChatAgentService, useValue: commonChatAgentService },
        { provide: PlannerService, useValue: planner },
        { provide: STEP_EVALUATOR, useValue: stepEvaluator },
        { provide: AgentFlowTaskEventService, useValue: taskEventService },
      ],
    }).compile();
    activities = module.get(AgentFlowActivities);
  });

  it('只将冻结版本的节点推进投影交给 Temporal', async () => {
    prisma.streamTask.findUnique.mockResolvedValue({
      id: 'task-1',
      flowVersionId: 'version-1',
      flowDigest: 'a'.repeat(64),
      flowVersion: {
        id: 'version-1',
        digest: 'a'.repeat(64),
        definition: flowDefinition(),
      },
    });

    await expect(activities.loadRunSnapshot(workflowInput())).resolves.toEqual({
      entryNodeKey: 'review',
      maxDurationSeconds: 60,
      nodes: [
        {
          key: 'review',
          type: 'approval',
          next: { approved: 'answer' },
        },
        { key: 'answer', type: 'synthesize', next: {} },
      ],
    });
  });

  it('拒绝任务、输入和版本间不一致的 digest 快照', async () => {
    prisma.streamTask.findUnique.mockResolvedValue({
      id: 'task-1',
      flowVersionId: 'version-1',
      flowDigest: 'b'.repeat(64),
      flowVersion: {
        id: 'version-1',
        digest: 'a'.repeat(64),
        definition: flowDefinition(),
      },
    });

    await expect(activities.loadRunSnapshot(workflowInput())).rejects.toThrow(
      'Flow digest 与任务快照不一致',
    );
  });

  it('已编译的 agent 节点通过底层 Agent 执行，并投影 Flow 生命周期事件', async () => {
    prisma.streamTask.findUnique.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      currentRunId: 'run-1',
      agentId: 'agent-1',
      fullContent: '',
      executionState: null,
      requestPayload: {},
      flowVersionId: 'version-1',
      flowDigest: 'a'.repeat(64),
      flowVersion: {
        id: 'version-1',
        flowId: 'flow-1',
        digest: 'a'.repeat(64),
        definition: flowDefinition(),
      },
    });
    prisma.agent.findUnique.mockResolvedValue({
      modelPreset: 'openai:test',
      systemPrompt: null,
    });
    flowCompiler.compile.mockReturnValue({
      success: true,
      plan: {
        nodes: [
          {
            key: 'answer',
            type: 'agent',
            next: {},
            modelPreset: 'openai:test',
            toolGroups: [],
            skills: [],
            maxToolIterations: 1,
            approvalToolNames: [],
          },
        ],
      },
    });
    capabilityResolver.resolve.mockResolvedValue({
      tools: [],
      systemPromptAdditions: [],
      approvalToolNames: [],
    });
    chatContextService.buildContextBundle.mockResolvedValue({
      messages: [{ role: 'user', content: '你好' }],
    });
    commonChatAgentService.streamEvents.mockReturnValue(emptyEventStream());

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'answer',
        nodeExecutionId: 'task-1:version-1:answer',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'default',
      summary: '节点执行完成',
    });
    expect(commonChatAgentService.streamEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPreset: 'openai:test',
        tools: [],
        threadId: 'task-1:version-1:answer',
      }),
    );
    expect(taskEventService.persistInTransaction).toHaveBeenCalledTimes(3);
  });

  it('同一轮多个工具请求共用一个审批批次并完整持久化', async () => {
    mockExecutionContext({
      node: {
        key: 'execute',
        type: 'agent',
        next: {},
        modelPreset: 'openai:test',
        toolGroups: ['orders'],
        skills: [],
        maxToolIterations: 2,
        approvalToolNames: ['create-order', 'cancel-order'],
      },
    });
    capabilityResolver.resolve.mockResolvedValue({
      tools: [],
      systemPromptAdditions: [],
      approvalToolNames: ['create-order', 'cancel-order'],
    });
    chatContextService.buildContextBundle.mockResolvedValue({
      messages: [{ role: 'user', content: '处理订单' }],
    });
    commonChatAgentService.streamEvents.mockReturnValue(
      approvalEventStream([
        {
          toolName: 'create-order',
          args: '{"item":"burger"}',
          description: '创建订单',
          allowedDecisions: ['approve', 'reject', 'edit'],
          index: 0,
        },
        {
          toolName: 'cancel-order',
          args: '{"orderId":"order-1"}',
          description: '取消订单',
          allowedDecisions: ['approve', 'reject', 'edit'],
          index: 1,
        },
      ]),
    );
    prisma.agentFlowApproval.findFirst.mockResolvedValue(null);
    prisma.agentFlowApproval.create.mockResolvedValue({
      id: 'approval-batch-1',
    });

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'execute',
        nodeExecutionId: 'task-1:version-1:execute',
      }),
    ).resolves.toEqual({
      kind: 'waiting_human',
      approvalId: 'approval-batch-1',
      timeoutSeconds: 900,
    });

    expect(prisma.agentFlowApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestSummary: expect.objectContaining({
          requests: [
            expect.objectContaining({ toolName: 'create-order', index: 0 }),
            expect.objectContaining({ toolName: 'cancel-order', index: 1 }),
          ],
          allowedDecisions: ['approve', 'reject'],
        }),
      }),
    });
    expect(taskEventService.persistInTransaction).toHaveBeenLastCalledWith(
      prisma,
      expect.objectContaining({
        payload: expect.objectContaining({
          approval: expect.objectContaining({
            kind: 'tool',
            requests: [
              expect.objectContaining({ toolName: 'create-order', index: 0 }),
              expect.objectContaining({ toolName: 'cancel-order', index: 1 }),
            ],
            allowedDecisions: ['approve', 'reject'],
          }),
        }),
      }),
    );
  });

  it('plan 节点将生成的计划持久化到 Flow 执行状态后完成', async () => {
    mockExecutionContext({
      node: {
        key: 'plan',
        type: 'plan',
        next: { default: 'review' },
        maxSteps: 3,
      },
    });
    chatContextService.buildContextBundle.mockResolvedValue({
      messages: [{ role: 'user', content: '帮我安排旅行' }],
    });
    planner.plan.mockResolvedValue({
      steps: [{ id: 'step-1', goal: '确认目的地' }],
      fromModel: true,
    });

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'plan',
        nodeExecutionId: 'task-1:version-1:plan',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'default',
      summary: '已生成 1 个计划步骤',
    });

    expect(planner.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: '帮我安排旅行' }],
      }),
      3,
      [],
    );
    expect(taskEventService.persistInTransaction).toHaveBeenLastCalledWith(
      prisma,
      expect.objectContaining({
        eventName: 'flow.node.completed',
        taskUpdate: expect.objectContaining({
          executionState: expect.objectContaining({
            agentFlow: expect.objectContaining({
              plan: expect.objectContaining({
                revision: 0,
                steps: [{ id: 'step-1', goal: '确认目的地' }],
              }),
            }),
          }),
        }),
      }),
    );
  });

  it('approval 节点为计划审批写入持久化等待事实', async () => {
    mockExecutionContext({
      node: {
        key: 'review',
        type: 'approval',
        next: { approved: 'execute' },
        kind: 'plan-review',
      },
      executionState: {
        agentFlow: {
          started: true,
          completedNodes: {},
          plan: {
            steps: [{ id: 'step-1', goal: '确认目的地' }],
            fromModel: true,
            revision: 0,
            feedback: [],
          },
        },
      },
    });
    prisma.agentFlowApproval.findFirst.mockResolvedValue(null);
    prisma.agentFlowApproval.create.mockResolvedValue({
      id: 'approval-plan-1',
    });

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'review',
        nodeExecutionId: 'task-1:version-1:review',
      }),
    ).resolves.toEqual({
      kind: 'waiting_human',
      approvalId: 'approval-plan-1',
      timeoutSeconds: 900,
    });

    expect(prisma.agentFlowApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'PLAN_REVIEW',
        nodeKey: 'review',
        requestSummary: expect.objectContaining({
          revision: 0,
          steps: [{ id: 'step-1', goal: '确认目的地' }],
        }),
      }),
    });
    expect(taskEventService.persistInTransaction).toHaveBeenLastCalledWith(
      prisma,
      expect.objectContaining({
        eventName: 'flow.waiting_human',
        payload: expect.objectContaining({
          approvalId: 'approval-plan-1',
          approval: expect.objectContaining({ kind: 'plan-review' }),
        }),
      }),
    );
  });

  it('plan-loop 节点逐步执行计划并持久化步骤进度', async () => {
    mockExecutionContext({
      node: {
        key: 'execute',
        type: 'plan-loop',
        next: { default: 'answer' },
        planLoopPolicy: {
          stopPolicy: 'all-steps',
          planReview: 'disabled',
          maxSteps: 3,
        },
        executor: {
          modelPreset: 'openai:test',
          toolGroups: [],
          skills: [],
          maxToolIterations: 1,
          approvalToolNames: [],
        },
      },
      executionState: {
        agentFlow: {
          started: true,
          completedNodes: {},
          plan: {
            steps: [{ id: 'step-1', goal: '确认目的地' }],
            fromModel: true,
            revision: 0,
            feedback: [],
          },
        },
      },
    });
    capabilityResolver.resolve.mockResolvedValue({
      tools: [],
      systemPromptAdditions: [],
      approvalToolNames: [],
    });
    chatContextService.buildContextBundle.mockResolvedValue({
      messages: [{ role: 'user', content: '帮我安排旅行' }],
    });
    commonChatAgentService.streamEvents.mockReturnValue(
      textEventStream('已确认目的地'),
    );

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'execute',
        nodeExecutionId: 'task-1:version-1:execute',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'default',
      summary: '已完成 1 个计划步骤',
    });

    expect(commonChatAgentService.streamEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'task-1:version-1:execute:step:step-1',
        systemPrompt: expect.stringContaining('当前步骤'),
      }),
    );
    expect(prisma.streamTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          executionState: expect.objectContaining({
            agentFlow: expect.objectContaining({
              planLoop: expect.objectContaining({ stepIndex: 1 }),
            }),
          }),
        }),
      }),
    );
  });

  it('审批等待超时时同步收敛待处理审批与 trace', async () => {
    prisma.streamTask.findUnique.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      currentRunId: 'run-1',
      fullContent: '',
      status: 'WAITING_HUMAN',
    });
    prisma.agentFlowApproval.findMany.mockResolvedValue([
      { id: 'approval-1', traceItemId: 'trace-1' },
    ]);

    await activities.finalizeRun({
      workflow: workflowInput(),
      status: 'timed_out',
      lastNodeKey: 'review',
    });

    expect(prisma.agentFlowApproval.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task-1', status: 'PENDING' },
      data: { status: 'TIMED_OUT' },
    });
    expect(prisma.conversationTurnTraceItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['trace-1'] },
        status: 'RUNNING',
      },
      data: expect.objectContaining({
        status: 'ERROR',
        summary: '审批等待超时',
      }),
    });
  });

  it('任务已取消时不再继续调用 Flow 节点执行器', async () => {
    mockExecutionContext({
      node: {
        key: 'answer',
        type: 'agent',
        next: {},
        modelPreset: 'openai:test',
        toolGroups: [],
        skills: [],
        maxToolIterations: 1,
        approvalToolNames: [],
      },
      status: 'CANCELED',
    });

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'answer',
        nodeExecutionId: 'task-1:version-1:answer',
      }),
    ).resolves.toEqual({ kind: 'stopped', status: 'cancelled' });

    expect(commonChatAgentService.streamEvents).not.toHaveBeenCalled();
  });

  it('计划审批 edit 未提供步骤列表时仍完成当前审批节点', async () => {
    mockExecutionContext({
      node: {
        key: 'review',
        type: 'approval',
        next: { approved: 'execute' },
        kind: 'plan-review',
      },
      executionState: {
        agentFlow: {
          started: true,
          completedNodes: {},
          plan: {
            steps: [{ id: 'step-1', goal: '确认目的地' }],
            fromModel: true,
            maxSteps: 3,
            revision: 0,
            feedback: [],
          },
        },
      },
    });
    prisma.agentFlowApproval.findUnique.mockResolvedValue({
      taskId: 'task-1',
      nodeKey: 'review',
      kind: 'PLAN_REVIEW',
      status: 'RESOLVED',
      decision: { decision: 'edit' },
    });

    await expect(
      activities.resumeNode({
        workflow: workflowInput(),
        nodeKey: 'review',
        nodeExecutionId: 'task-1:version-1:review',
        approvalId: 'approval-plan-1',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'approved',
      summary: '已确认修改后的 0 个计划步骤',
    });
  });

  /**
   * 设置一个可由 Activity 编译的冻结任务上下文
   * @param input 当前节点与可选执行状态
   * @returns 无返回值
   * @description 单测只替换本次执行相关的已编译节点，任务、FlowVersion 和 Agent 快照保持与真实 Activity 查询结构一致。
   */
  function mockExecutionContext(input: {
    node: Record<string, unknown>;
    executionState?: Record<string, unknown>;
    status?: string;
  }): void {
    prisma.streamTask.findUnique.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      currentRunId: 'run-1',
      agentId: 'agent-1',
      fullContent: '',
      status: input.status ?? 'STREAMING',
      executionState: input.executionState ?? null,
      requestPayload: {},
      flowVersionId: 'version-1',
      flowDigest: 'a'.repeat(64),
      flowVersion: {
        id: 'version-1',
        flowId: 'flow-1',
        digest: 'a'.repeat(64),
        definition: flowDefinition(),
      },
    });
    prisma.agent.findUnique.mockResolvedValue({
      modelPreset: 'openai:test',
      systemPrompt: null,
    });
    flowCompiler.compile.mockReturnValue({
      success: true,
      plan: { nodes: [input.node] },
    });
  }
});

/**
 * 构造不产出文本或审批事件的底层 Agent 流
 * @returns 返回空的异步事件流
 * @description 用于验证 Flow 节点的生命周期投影，不依赖真实模型、Redis 或 Temporal Worker。
 */
async function* emptyEventStream() {
  await Promise.resolve();
  yield* [];
}

/**
 * 构造只输出一段文本的底层 Agent 流
 * @param delta 当前计划步骤生成的内部观察文本
 * @returns 返回单条消息增量的异步事件流
 * @description 用于验证 PlanLoop 将步骤文本留在执行状态而不泄漏到客户端最终回复流。
 */
async function* textEventStream(delta: string) {
  await Promise.resolve();
  yield { type: 'message.delta' as const, delta };
}

/**
 * 构造同一轮包含多个工具审批请求的底层 Agent 流
 * @param requests 当前审批批次中的工具请求
 * @returns 返回按顺序产出审批事件的异步事件流
 * @description 用于验证 Flow 将一次 LangGraph interrupt 作为单个持久化审批事实处理。
 */
async function* approvalEventStream(
  requests: Array<{
    toolName: string;
    args?: string;
    description?: string;
    allowedDecisions: Array<'approve' | 'reject' | 'edit'>;
    index: number;
  }>,
) {
  await Promise.resolve();
  for (const request of requests) {
    yield {
      type: 'approval.required' as const,
      payload: request,
    };
  }
}

/**
 * 构造 Temporal Workflow 的最小业务标识
 * @returns 返回不含对话正文或用户凭据的工作流输入
 * @description Activity 仅凭这些冻结标识读取任务与版本，避免敏感数据进入 Temporal History。
 */
function workflowInput(): AgentFlowWorkflowInput {
  return {
    streamTaskId: 'task-1',
    flowVersionId: 'version-1',
    flowDigest: 'a'.repeat(64),
    activityTaskQueue: 'agent-flow-activity',
  };
}

/**
 * 构造最小可校验的 FlowDefinition
 * @returns 返回审批后进入汇总节点的标准 JSON
 * @description 使用真实 Definition 校验器路径，确保 Activity 的投影逻辑没有手写旁路。
 */
function flowDefinition() {
  return {
    schemaVersion: 1,
    kind: 'agent-flow' as const,
    name: '审批后回复',
    policy: {
      maxSteps: 1,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxDurationSeconds: 60,
    },
    nodes: [
      {
        id: 'review',
        type: 'approval' as const,
        config: { kind: 'plan-review' as const },
      },
      {
        id: 'answer',
        type: 'synthesize' as const,
        config: {},
      },
    ],
    edges: [{ from: 'review', to: 'answer', when: 'approved' as const }],
  };
}
