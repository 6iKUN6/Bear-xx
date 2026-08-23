import { AGENT_FLOW_SCHEMA_VERSION } from '@litter-bear/types/agent-flow';
import { StreamTaskEventType } from '@litter-bear/types/protocol';
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
import { LlmService } from '../../llm/llm.service';
import { AgentFlowActivities } from './agent-flow.activities';

describe('AgentFlowActivities', () => {
  let activities: AgentFlowActivities;
  const prisma = {
    streamTask: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    agent: {
      findUnique: jest.fn(),
    },
    agentFlowNodeExecution: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    agentFlowNodeState: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
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
  const llmService = { generateStructured: jest.fn() };
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
    // 默认「本节点尚无终局记录、尚未抢到 run.started」，各用例只覆盖它们关心的那一项
    prisma.agentFlowNodeExecution.findUnique.mockResolvedValue(null);
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([]);
    // 默认「本节点还没有私有状态」，需要断言轮次或步骤进度的用例再各自覆盖
    prisma.agentFlowNodeState.findUnique.mockResolvedValue(null);
    prisma.agentFlowNodeState.upsert.mockResolvedValue({});
    prisma.streamTask.updateMany.mockResolvedValue({ count: 1 });
    prisma.streamTask.update.mockResolvedValue({
      flowModelCalls: 0,
      flowToolCalls: 0,
    });
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
        { provide: LlmService, useValue: llmService },
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
      entryNodeKey: 'start',
      maxDurationSeconds: 60,
      nodes: [
        { key: 'start', type: 'start', next: { default: ['plan'] } },
        { key: 'plan', type: 'plan', next: { default: ['review'] } },
        {
          key: 'review',
          type: 'approval',
          next: { approved: ['answer'] },
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

  it('模型调用以原子 increment 计入预算计数列', async () => {
    mockAgentNode();
    // flowDefinition 的 maxModelCalls 为 1，恰好允许一次模型调用
    commonChatAgentService.streamEvents.mockImplementation(
      (request: { onModelTurn?: () => void }) => {
        request.onModelTurn?.();
        return emptyEventStream();
      },
    );

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
    expect(readBudgetIncrement()).toEqual({
      modelCalls: { increment: 1 },
      toolCalls: { increment: 0 },
    });
  });

  it('模型调用额度已用尽时不再发起模型调用', async () => {
    mockAgentNode({
      // maxModelCalls 为 1，历史用量已达上限
      budgetUsage: { modelCalls: 1, toolCalls: 0 },
    });

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'answer',
        nodeExecutionId: 'task-1:version-1:answer',
      }),
    ).resolves.toEqual({
      kind: 'stopped',
      status: 'error',
      errorCategory: 'budget_exceeded',
    });
    expect(commonChatAgentService.streamEvents).not.toHaveBeenCalled();
  });

  it('突破工具调用预算时中断流并以 flow.node.failed 收敛', async () => {
    mockAgentNode();
    // flowDefinition 的 maxToolCalls 为 0：第一次工具请求即超额
    const afterOverspend = jest.fn();
    commonChatAgentService.streamEvents.mockReturnValue(
      toolCallEventStream(afterOverspend),
    );

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'answer',
        nodeExecutionId: 'task-1:version-1:answer',
      }),
    ).resolves.toEqual({
      kind: 'stopped',
      status: 'error',
      errorCategory: 'budget_exceeded',
    });
    // 超额判定必须发生在同一个事件上：放到下一个事件才判会放过一次超额工具执行
    expect(afterOverspend).not.toHaveBeenCalled();
    expect(lastPersistedEventName()).toBe('flow.node.failed');
  });

  it('maxToolCalls 为 0 的纯问答节点仍然可以正常执行', async () => {
    mockAgentNode();
    // 回归用：准入检查若同时要求工具额度，禁用工具的 Flow 会一次都跑不起来
    commonChatAgentService.streamEvents.mockReturnValue(
      textEventStream('好的'),
    );

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'answer',
        nodeExecutionId: 'task-1:version-1:answer',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'default',
      summary: '已生成回复',
    });
  });

  it('同一轮多个工具请求共用一个审批批次并完整持久化', async () => {
    mockExecutionContext({
      node: {
        key: 'execute',
        type: 'agent',
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

  it('plan 节点把生成的计划写成自己的声明输出', async () => {
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
    // 计划是本节点的**声明输出**，下游经 $ref 读它；此前它藏在 executionState 的全局
    // blob 里，图上有两个 plan 节点时根本说不清用的是哪份
    expect(prisma.agentFlowNodeExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        nodeKey: 'plan',
        result: 'COMPLETED',
        outputs: {
          steps: [{ id: 'step-1', goal: '确认目的地' }],
          stepCount: 1,
        },
      }),
    });
  });

  it('approval 节点为计划审批写入持久化等待事实', async () => {
    mockExecutionContext({
      node: {
        key: 'review',
        type: 'approval',
        next: { approved: 'execute' },
        kind: 'plan-review',
        policy: 'always',
        planRef: { $ref: ['plan', 'steps'] },
      },
    });
    // 待审计划来自上游 plan 节点的声明输出，不再是全局状态
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([
      {
        nodeKey: 'plan',
        outputs: {
          steps: [{ id: 'step-1', goal: '确认目的地' }],
          stepCount: 1,
        },
      },
    ]);
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
        planRef: { $ref: ['plan', 'steps'] },
      },
    });
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([
      {
        nodeKey: 'plan',
        outputs: {
          steps: [{ id: 'step-1', goal: '确认目的地' }],
          stepCount: 1,
        },
      },
    ]);
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
    // 步骤进度是**本节点私有**的 scratch，与存终局事实的 AgentFlowNodeExecution 分表：
    // 后者「有行即已终结」，混在一起会把 create 变成 upsert，毁掉基于唯一键的幂等收敛
    expect(prisma.agentFlowNodeState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          taskId_nodeExecutionId: {
            taskId: 'task-1',
            nodeExecutionId: 'task-1:version-1:execute',
          },
        },
        update: {
          state: expect.objectContaining({
            stepIndex: 1,
            observations: ['已确认目的地'],
          }),
        },
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
        policy: 'always',
        planRef: { $ref: ['plan', 'steps'] },
      },
    });
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([
      {
        nodeKey: 'plan',
        outputs: {
          steps: [{ id: 'step-1', goal: '确认目的地' }],
          stepCount: 1,
        },
      },
    ]);
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

  it('节点已有完成记录时直接回放，不再调用模型', async () => {
    mockAgentNode();
    prisma.agentFlowNodeExecution.findUnique.mockResolvedValue({
      result: 'COMPLETED',
      outcome: 'default',
      summary: '已生成回复',
      errorCategory: null,
    });

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'answer',
        nodeExecutionId: 'task-1:version-1:answer',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'default',
      summary: '已生成回复',
    });
    expect(commonChatAgentService.streamEvents).not.toHaveBeenCalled();
  });

  it('审批恢复路径同样回放已完成节点，不重跑已审批通过的工具', async () => {
    // 回归用：resumeNode 曾没有幂等短路。节点事务已提交而结果上报丢失时，Temporal 会带着
    // 同一份决定重试，把模型和已放行的工具整个重跑一遍。
    mockExecutionContext({
      node: {
        key: 'answer',
        type: 'agent',
        modelPreset: 'openai:test',
        toolGroups: [],
        skills: [],
        maxToolIterations: 1,
        approvalToolNames: ['create_order'],
      },
    });
    prisma.agentFlowNodeExecution.findUnique.mockResolvedValue({
      result: 'COMPLETED',
      outcome: 'default',
      summary: '已生成回复',
      errorCategory: null,
    });

    await expect(
      activities.resumeNode({
        workflow: workflowInput(),
        nodeKey: 'answer',
        nodeExecutionId: 'task-1:version-1:answer',
        approvalId: 'approval-1',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'default',
      summary: '已生成回复',
    });
    expect(commonChatAgentService.resumeEvents).not.toHaveBeenCalled();
  });

  it('节点完成记录与完成事件写在同一个事务里', async () => {
    mockAgentNode();
    commonChatAgentService.streamEvents.mockReturnValue(
      textEventStream('好的'),
    );

    await activities.executeNode({
      workflow: workflowInput(),
      nodeKey: 'answer',
      nodeExecutionId: 'task-1:version-1:answer',
    });

    // 事件发出而幂等记录缺失，重试就会重复执行副作用；两者必须同生共死
    expect(prisma.agentFlowNodeExecution.create).toHaveBeenCalledWith({
      data: {
        taskId: 'task-1',
        nodeExecutionId: 'task-1:version-1:answer',
        nodeKey: 'answer',
        result: 'COMPLETED',
        outcome: 'default',
        // 声明输出与幂等记录同一行落库，下游 condition 才能经 $ref 读到它
        outputs: { text: '好的' },
        summary: '已生成回复',
      },
    });
  });

  it('没抢到 run.started 声明的节点不再重复发运行开始事件', async () => {
    mockAgentNode();
    // 条件更新命中 0 行 = 别的节点已经声明过；并行扇出时多个首节点会同时走到这里
    prisma.streamTask.updateMany.mockResolvedValue({ count: 0 });
    commonChatAgentService.streamEvents.mockReturnValue(emptyEventStream());

    await activities.executeNode({
      workflow: workflowInput(),
      nodeKey: 'answer',
      nodeExecutionId: 'task-1:version-1:answer',
    });

    const eventNames = taskEventService.persistInTransaction.mock.calls.map(
      (call: unknown[]) => (call[1] as { eventName?: unknown }).eventName,
    );
    expect(eventNames).not.toContain('flow.run.started');
    expect(eventNames).toContain('flow.node.started');
  });

  it('condition 节点按上游已落库的输出命中分支', async () => {
    mockConditionNode();
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([
      { nodeKey: 'plan', outputs: { steps: [], stepCount: 5 } },
    ]);

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'classify',
        nodeExecutionId: 'task-1:version-1:classify',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'case_1',
      summary: '命中分支「case_1」',
    });
    // 条件判定不该调模型：它只读已落库的输出
    expect(commonChatAgentService.streamEvents).not.toHaveBeenCalled();
  });

  it('condition 全不命中时走隐含的 else 分支', async () => {
    mockConditionNode();
    // stepCount 为 1，不满足 gt 3
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([
      { nodeKey: 'plan', outputs: { steps: [], stepCount: 1 } },
    ]);

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'classify',
        nodeExecutionId: 'task-1:version-1:classify',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'else',
      summary: '命中分支「else」',
    });
  });

  it('condition 引用的上游输出缺失时显式失败，不静默走 else', async () => {
    // ref-dominates 已保证被引节点必定先完成，读不到就是我们自己的写入漏了。
    // 静默判 false 会让分支永远走 else —— 那正是旧 condition stub「永远算不对」的失败方式。
    mockConditionNode();
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([]);

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'classify',
        nodeExecutionId: 'task-1:version-1:classify',
      }),
    ).rejects.toThrow('没有已落库的输出');
  });

  /**
   * 装配 start 节点的执行上下文
   * @returns 无返回值
   * @description requestPayload.content 就是 start 节点声明输出 text 的来源。
   */
  function mockStartNode(): void {
    mockConditionNode();
    flowCompiler.compile.mockReturnValue({
      success: true,
      plan: {
        nodes: [{ key: 'start', type: 'start', next: { default: 'plan' } }],
      },
    });
  }

  /**
   * 装配一个待审批节点的执行上下文
   * @param policy 门禁策略
   * @param budgetUsage 可选的历史预算用量，用于覆盖额度耗尽场景
   * @returns 无返回值
   * @description 待审计划来自上游 plan 节点的声明输出。
   */
  function mockApprovalNode(
    policy: 'always' | 'never' | 'model',
    budgetUsage?: { modelCalls: number; toolCalls: number },
  ): void {
    mockExecutionContext({
      node: {
        key: 'review',
        type: 'approval',
        next: { approved: 'execute' },
        kind: 'plan-review',
        policy,
        planRef: { $ref: ['plan', 'steps'] },
      },
      ...(budgetUsage ? { budgetUsage } : {}),
    });
    prisma.agentFlowNodeExecution.findMany.mockResolvedValue([
      {
        nodeKey: 'plan',
        outputs: {
          steps: [{ id: 'step-1', goal: '确认目的地' }],
          stepCount: 1,
        },
      },
    ]);
    prisma.agentFlowApproval.findFirst.mockResolvedValue(null);
    prisma.agentFlowApproval.create.mockResolvedValue({ id: 'approval-1' });
  }

  /**
   * 装配一个条件分支节点的执行上下文
   * @returns 无返回值
   * @description Definition 必须真的含 condition 节点：分支键合法性由共享契约的
   * flowNodeBranchKeys 从 Definition 读出，手写编译节点绕不过去。
   */
  function mockConditionNode(): void {
    prisma.streamTask.findUnique.mockResolvedValue({
      id: 'task-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      currentRunId: 'run-1',
      agentId: 'agent-1',
      fullContent: '',
      status: 'STREAMING',
      executionState: null,
      flowModelCalls: 0,
      flowToolCalls: 0,
      requestPayload: { content: '帮我查一下' },
      flowVersionId: 'version-1',
      flowDigest: 'a'.repeat(64),
      flowVersion: {
        id: 'version-1',
        flowId: 'flow-1',
        digest: 'a'.repeat(64),
        definition: conditionFlowDefinition(),
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
            key: 'classify',
            type: 'condition',
            next: { case_1: 'answer', else: 'brief' },
            cases: conditionFlowDefinition().nodes[2].config.cases,
          },
        ],
      },
    });
  }

  it('start 节点把用户消息作为声明输出落库，不调模型', async () => {
    // start.text 是下游经 $ref 引用的锚点；不落库的话 condition 会撞上
    // 「上游节点没有已落库的输出」并显式失败
    mockStartNode();

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'start',
        nodeExecutionId: 'task-1:version-1:start',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'default',
      summary: '流程开始',
    });
    expect(commonChatAgentService.streamEvents).not.toHaveBeenCalled();
    expect(prisma.agentFlowNodeExecution.create).toHaveBeenCalledWith({
      data: {
        taskId: 'task-1',
        nodeExecutionId: 'task-1:version-1:start',
        nodeKey: 'start',
        result: 'COMPLETED',
        outcome: 'default',
        outputs: { text: '帮我查一下' },
        summary: '流程开始',
      },
    });
  });

  it('节点别名进入 flow.node.started 的展示标题', async () => {
    // 别名是管理员为这张图里这个节点起的名字，比通用类型标题更能说明它在做什么
    mockAgentNode();
    flowCompiler.compile.mockReturnValue({
      success: true,
      plan: {
        nodes: [
          {
            key: 'answer',
            name: '生成客服回复',
            type: 'agent',
            modelPreset: 'openai:test',
            toolGroups: [],
            skills: [],
            maxToolIterations: 1,
            approvalToolNames: [],
          },
        ],
      },
    });
    commonChatAgentService.streamEvents.mockReturnValue(emptyEventStream());

    await activities.executeNode({
      workflow: workflowInput(),
      nodeKey: 'answer',
      nodeExecutionId: 'task-1:version-1:answer',
    });

    const started = taskEventService.persistInTransaction.mock.calls
      .map(
        (call: unknown[]) =>
          call[1] as { eventName?: unknown; payload?: unknown },
      )
      .find((event) => event.eventName === 'flow.node.started');
    expect((started?.payload as { title?: unknown } | undefined)?.title).toBe(
      '生成客服回复',
    );
  });

  it('没有别名时回退到节点类型标题', async () => {
    mockAgentNode();
    commonChatAgentService.streamEvents.mockReturnValue(emptyEventStream());

    await activities.executeNode({
      workflow: workflowInput(),
      nodeKey: 'answer',
      nodeExecutionId: 'task-1:version-1:answer',
    });

    const started = taskEventService.persistInTransaction.mock.calls
      .map(
        (call: unknown[]) =>
          call[1] as { eventName?: unknown; payload?: unknown },
      )
      .find((event) => event.eventName === 'flow.node.started');
    expect((started?.payload as { title?: unknown } | undefined)?.title).toBe(
      '执行智能体节点',
    );
  });

  it('终节点吐字并把正文写进任务', async () => {
    mockAgentNode();
    commonChatAgentService.streamEvents.mockReturnValue(
      textEventStream('你好'),
    );

    await activities.executeNode({
      workflow: workflowInput(),
      nodeKey: 'answer',
      nodeExecutionId: 'task-1:version-1:answer',
    });

    expect(taskEventService.publishTransient).toHaveBeenCalledWith(
      'task-1',
      StreamTaskEventType.MessageDelta,
      expect.stringContaining('你好'),
    );
    expect(readCompletedFullContent()).toBe('你好');
  });

  it('中间 agent 节点不吐字，正文只进声明输出', async () => {
    // 并行分支里的 agent 节点走的就是这条路径：它的 token 不能进这条助手消息的正文，
    // 否则两条分支会交错写同一段文本、并各写一次 fullContent 后互相覆盖。
    mockExecutionContext({
      node: {
        key: 'draft',
        type: 'agent',
        modelPreset: 'openai:test',
        toolGroups: [],
        skills: [],
        maxToolIterations: 1,
        approvalToolNames: [],
      },
      definition: draftThenAnswerDefinition(),
    });
    capabilityResolver.resolve.mockResolvedValue({
      tools: [],
      systemPromptAdditions: [],
      approvalToolNames: [],
    });
    chatContextService.buildContextBundle.mockResolvedValue({
      messages: [{ role: 'user', content: '你好' }],
    });
    commonChatAgentService.streamEvents.mockReturnValue(
      textEventStream('中间产出'),
    );

    await activities.executeNode({
      workflow: workflowInput(),
      nodeKey: 'draft',
      nodeExecutionId: 'task-1:version-1:draft',
    });

    expect(taskEventService.publishTransient).not.toHaveBeenCalledWith(
      'task-1',
      StreamTaskEventType.MessageDelta,
      expect.anything(),
    );
    // 正文没有被写进任务，但作为节点声明输出留给了下游 $ref
    expect(readCompletedFullContent()).toBeUndefined();
    expect(readCompletedOutputs()).toEqual({ text: '中间产出' });
  });

  it('门禁 never 时自动确认计划，不创建人工等待', async () => {
    mockApprovalNode('never');

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'review',
        nodeExecutionId: 'task-1:version-1:review',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      outcome: 'approved',
      summary: '按配置自动确认计划',
    });
    expect(prisma.agentFlowApproval.create).not.toHaveBeenCalled();
    // 确认后的计划要成为本节点的输出，下游才能引用「人确认过的那份」
    expect(prisma.agentFlowNodeExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outputs: expect.objectContaining({
          approved: true,
          steps: [{ id: 'step-1', goal: '确认目的地' }],
        }),
      }),
    });
  });

  it('门禁 model 判定无需人工时自动确认', async () => {
    mockApprovalNode('model');
    llmService.generateStructured.mockResolvedValue({
      needsReview: false,
      reason: '纯查询无副作用',
    });

    const result = await activities.executeNode({
      workflow: workflowInput(),
      nodeKey: 'review',
      nodeExecutionId: 'task-1:version-1:review',
    });

    expect(result).toMatchObject({ kind: 'completed', outcome: 'approved' });
    expect(prisma.agentFlowApproval.create).not.toHaveBeenCalled();
  });

  it('门禁 model 判定需要人工时照常等待', async () => {
    mockApprovalNode('model');
    llmService.generateStructured.mockResolvedValue({
      needsReview: true,
      reason: '涉及下单',
    });

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'review',
        nodeExecutionId: 'task-1:version-1:review',
      }),
    ).resolves.toMatchObject({ kind: 'waiting_human' });
  });

  it.each([
    ['输出非法', () => Promise.resolve(null)],
    ['调用抛错', () => Promise.reject(new Error('upstream down'))],
  ])('门禁 model 在%s时闭合为需要人工确认', async (_label, behavior) => {
    // 失败闭合：漏掉一次该确认的，代价远大于多问一次。失败开放在门禁上不是可接受的默认值。
    mockApprovalNode('model');
    llmService.generateStructured.mockImplementation(behavior);

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'review',
        nodeExecutionId: 'task-1:version-1:review',
      }),
    ).resolves.toMatchObject({ kind: 'waiting_human' });
  });

  it('门禁 model 在模型额度已用尽时闭合为需要人工确认，且不再调模型', async () => {
    mockApprovalNode('model', { modelCalls: 1, toolCalls: 0 });

    await expect(
      activities.executeNode({
        workflow: workflowInput(),
        nodeKey: 'review',
        nodeExecutionId: 'task-1:version-1:review',
      }),
    ).resolves.toMatchObject({ kind: 'waiting_human' });
    expect(llmService.generateStructured).not.toHaveBeenCalled();
  });

  /**
   * 设置一个可由 Activity 编译的冻结任务上下文
   * @param input 当前节点与可选执行状态
   * @returns 无返回值
   * @description 单测只替换本次执行相关的已编译节点，任务、FlowVersion 和 Agent 快照保持与真实 Activity 查询结构一致。
   */
  /**
   * 装配一个最小 Agent 节点的执行上下文
   * @param options 可选的已持久化执行状态与历史预算用量
   * @returns 无返回值
   * @description 预算相关用例只关心 policy 与用量，节点能力固定为无工具的单步 Agent。
   */
  function mockAgentNode(
    options: {
      executionState?: Record<string, unknown>;
      budgetUsage?: { modelCalls: number; toolCalls: number };
    } = {},
  ): void {
    mockExecutionContext({
      node: {
        key: 'answer',
        type: 'agent',
        modelPreset: 'openai:test',
        toolGroups: [],
        skills: [],
        maxToolIterations: 1,
        approvalToolNames: [],
      },
      ...options,
    });
    capabilityResolver.resolve.mockResolvedValue({
      tools: [],
      systemPromptAdditions: [],
      approvalToolNames: [],
    });
    chatContextService.buildContextBundle.mockResolvedValue({
      messages: [{ role: 'user', content: '你好' }],
    });
  }

  /**
   * 读取节点完成时回写任务的正文
   * @returns 返回本次完成写入的 fullContent；未写入时为 undefined
   * @description 「有没有写」和「写了什么」是两件事：中间节点必须完全不出现这个字段，
   * 而不是写一个空串——写空串会把已有正文清掉。
   */
  function readCompletedFullContent(): unknown {
    const calls = taskEventService.persistInTransaction.mock.calls as Array<
      [unknown, { taskUpdate?: Record<string, unknown> }]
    >;
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const update = calls[index][1]?.taskUpdate;
      if (update && 'fullContent' in update) {
        return update.fullContent;
      }
    }
    return undefined;
  }

  /**
   * 读取节点完成时落库的声明输出
   * @returns 返回写入 AgentFlowNodeExecution 的 outputs
   */
  function readCompletedOutputs(): unknown {
    const calls = prisma.agentFlowNodeExecution.create.mock.calls as Array<
      [{ data?: Record<string, unknown> }]
    >;
    return calls[calls.length - 1]?.[0]?.data?.outputs;
  }

  /**
   * 读取落库的预算增量
   * @returns 返回本次 Activity 累加进计数列的模型与工具调用数
   * @description 断言的是原子 increment 而不是绝对值：整块回写绝对值会被并发节点互相吞掉，
   * 这正是预算从 executionState 迁到计数列要解决的问题，因此断言必须盯住写法本身。
   */
  function readBudgetIncrement(): unknown {
    const calls = prisma.streamTask.update.mock.calls as Array<
      [{ data?: Record<string, unknown> }]
    >;
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const data = calls[index][0]?.data;
      if (data && 'flowModelCalls' in data) {
        return {
          modelCalls: data.flowModelCalls,
          toolCalls: data.flowToolCalls,
        };
      }
    }
    throw new Error('预算没有以原子 increment 写入计数列');
  }

  /**
   * 读取最后一次持久化的事件名
   * @returns 返回事件名
   */
  function lastPersistedEventName(): unknown {
    const calls = taskEventService.persistInTransaction.mock.calls;
    const last = calls[calls.length - 1][1] as { eventName?: unknown };
    return last.eventName;
  }

  function mockExecutionContext(input: {
    node: Record<string, unknown>;
    executionState?: Record<string, unknown>;
    budgetUsage?: { modelCalls: number; toolCalls: number };
    status?: string;
    definition?: ReturnType<typeof flowDefinition>;
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
      flowModelCalls: input.budgetUsage?.modelCalls ?? 0,
      flowToolCalls: input.budgetUsage?.toolCalls ?? 0,
      requestPayload: {},
      flowVersionId: 'version-1',
      flowDigest: 'a'.repeat(64),
      flowVersion: {
        id: 'version-1',
        flowId: 'flow-1',
        digest: 'a'.repeat(64),
        definition: input.definition ?? flowDefinition(),
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
 * 构造「中间 agent 节点 + 终节点」的 FlowDefinition
 * @returns 返回仅用于 Activity 输入的结构化 Definition
 * @description draft 有出边因此不是终节点，用来验证中间节点静默执行。运行时会重新校验
 * Definition，因此这里必须是一张真正合法的图（单入口、配置完整），不能只是形状凑数。
 */
function draftThenAnswerDefinition() {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow' as const,
    name: '中间节点后汇总',
    policy: {
      maxSteps: 1,
      maxModelCalls: 2,
      maxToolCalls: 0,
      maxDurationSeconds: 60,
    },
    nodes: [
      { id: 'start', type: 'start' as const, config: {} },
      {
        id: 'draft',
        type: 'agent' as const,
        config: {
          modelPreset: 'agent-default',
          toolGroups: [],
          skills: [],
          maxToolIterations: 1,
        },
      },
      { id: 'answer', type: 'synthesize' as const, config: {} },
    ],
    edges: [
      { from: 'start', to: 'draft' },
      { from: 'draft', to: 'answer' },
    ],
  };
}

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
 * 构造一个先请求工具、随后还有后续事件的底层 Agent 流
 * @param afterOverspend 工具请求之后的事件被消费时调用
 * @returns 返回工具生命周期事件流
 * @description afterOverspend 用来证明预算判定发生在工具请求那一刻：若消费方放过这个事件
 * 继续往下走，说明超额的工具调用已经被执行。
 */
async function* toolCallEventStream(afterOverspend: () => void) {
  await Promise.resolve();
  yield {
    type: 'tool.call.start' as const,
    payload: { toolCallId: 'call-1', name: 'search', index: 0 },
  };
  afterOverspend();
  yield { type: 'message.delta' as const, delta: '不该走到这里' };
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
 * 构造含条件分支的可校验 FlowDefinition
 * @returns 返回 plan 之后按计划步数分流的标准 JSON
 * @description plan 支配 classify，因此 plan.stepCount 满足 ref-dominates；两条分支都连出，
 * 满足分支完备性。
 */
function conditionFlowDefinition() {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow' as const,
    name: '按计划规模分流',
    policy: {
      maxSteps: 5,
      maxModelCalls: 4,
      maxToolCalls: 0,
      maxDurationSeconds: 60,
    },
    nodes: [
      { id: 'start', type: 'start' as const, config: {} },
      { id: 'plan', type: 'plan' as const, config: { maxSteps: 5 } },
      {
        id: 'classify',
        type: 'condition' as const,
        config: {
          cases: [
            {
              key: 'case_1',
              logic: 'and' as const,
              conditions: [
                {
                  ref: { $ref: ['plan', 'stepCount'] as [string, string] },
                  operator: 'gt' as const,
                  value: 3,
                },
              ],
            },
          ],
        },
      },
      { id: 'answer', type: 'synthesize' as const, config: {} },
      { id: 'brief', type: 'synthesize' as const, config: {} },
    ],
    edges: [
      { from: 'start', to: 'plan' },
      { from: 'plan', to: 'classify' },
      { from: 'classify', to: 'answer', when: 'case_1' },
      { from: 'classify', to: 'brief', when: 'else' },
    ],
  };
}

/**
 * 构造最小可校验的 FlowDefinition
 * @returns 返回审批后进入汇总节点的标准 JSON
 * @description 使用真实 Definition 校验器路径，确保 Activity 的投影逻辑没有手写旁路。
 */
function flowDefinition() {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow' as const,
    name: '审批后回复',
    policy: {
      maxSteps: 1,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxDurationSeconds: 60,
    },
    nodes: [
      { id: 'start', type: 'start' as const, config: {} },
      // approval 依赖 plan 节点写入的计划，图上必须有前置 plan：
      // 否则运行时会抛 AGENT_FLOW_PLAN_STATE_MISSING，发布校验也会拒绝。
      {
        id: 'plan',
        type: 'plan' as const,
        config: { maxSteps: 1 },
      },
      {
        id: 'review',
        type: 'approval' as const,
        config: {
          kind: 'plan-review' as const,
          policy: 'always' as const,
          planRef: { $ref: ['plan', 'steps'] as [string, string] },
        },
      },
      {
        id: 'answer',
        type: 'synthesize' as const,
        config: {},
      },
    ],
    edges: [
      { from: 'start', to: 'plan' },
      { from: 'plan', to: 'review' },
      { from: 'review', to: 'answer', when: 'approved' as const },
    ],
  };
}
