import { AgentFlowVersionStatus } from '@prisma/client';
import { createFlowDefinitionPreset } from '../agent-flow/definition/flow-definition.templates';
import { FlowTaskDispatcherService } from './flow-task-dispatcher.service';

describe('FlowTaskDispatcherService', () => {
  function createService(runtimeValid = true) {
    // 任务锁定期校验的替身：默认放行，专门的用例再让它失败
    const runtimeValidator = {
      validate: jest.fn(() =>
        runtimeValid
          ? { valid: true, errors: [] }
          : {
              valid: false,
              errors: [
                {
                  path: 'nodes.0.config.modelPreset',
                  rule: 'agent-default-resolved',
                  message: '任务未锁定智能体默认模型',
                },
              ],
            },
      ),
    };
    const prisma = {
      agent: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      streamTask: {
        update: jest.fn(),
      },
    };
    const temporalClient = {
      startWorkflow: jest.fn(),
    };
    // 内置 Flow 替身：默认已初始化，专门的用例再让它缺失
    const builtinFlow = {
      findDirectVersion: jest.fn().mockResolvedValue({
        id: 'builtin-version-1',
        digest: 'b'.repeat(64),
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      }),
    };

    return {
      service: new FlowTaskDispatcherService(
        prisma as never,
        temporalClient as never,
        runtimeValidator as never,
        builtinFlow as never,
      ),
      prisma,
      temporalClient,
      runtimeValidator,
      builtinFlow,
    };
  }

  it('仅为测试会话锁定 Agent 已发布 FlowVersion', async () => {
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      modelPreset: 'openai:gpt-5.5',
      defaultFlowVersion: {
        id: 'flow-version-1',
        digest: 'a'.repeat(64),
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      },
    });

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      { agentId: 'agent-1', isTest: true },
    );

    expect(snapshot).toEqual({
      flowVersionId: 'flow-version-1',
      flowDigest: 'a'.repeat(64),
      // 入口现在是声明式的 start 节点，不再是「第一个没有入边的业务节点」
      currentStep: 'start',
    });
  });

  it('智能体未配模型预设时在创建任务期就拒绝，不派发出去', async () => {
    // 内置模板的节点都写 agent-default，只有到任务锁定期才能解析成具体预设。
    // 不在这里拦，任务会被派发并在 Temporal Activity 里以
    // AGENT_FLOW_RUNTIME_CONTEXT_INVALID 死掉，用户只看到一句「流程执行失败」
    const { service, prisma, runtimeValidator } = createService(false);
    prisma.agent.findUnique.mockResolvedValue({
      modelPreset: null,
      defaultFlowVersion: {
        id: 'flow-version-1',
        digest: 'a'.repeat(64),
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      },
    });

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
        agentId: 'agent-1',
        isTest: true,
      }),
    ).rejects.toThrow(/无法运行/);

    expect(runtimeValidator.validate).toHaveBeenCalledWith(expect.anything(), {
      phase: 'task',
      agentDefaultModelPreset: null,
    });
  });

  it('普通聊天同样走 Flow，不再有 isTest 闸门', async () => {
    // 这条替代了原先的「普通聊天不查询 FlowVersion」：Flow 已是唯一编排路径
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      modelPreset: 'openai:gpt-5.5',
      defaultFlowVersion: null,
    });

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      { agentId: 'agent-1' },
    );

    expect(snapshot?.flowVersionId).toBe('builtin-version-1');
  });

  it('没有指定 Agent 时回落到 isDefault 的 Agent', async () => {
    // 内置 Flow 的 agent-default 需要一个具体的模型来源，「没有 Agent」提供不了。
    // 现存 34 个单聊里有 17 个没有 defaultAgentId，这条路径不是边角情况。
    const { service, prisma } = createService();
    prisma.agent.findFirst.mockResolvedValue({
      modelPreset: 'openai:gpt-5.5',
      defaultFlowVersion: null,
    });

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      {},
    );

    expect(prisma.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isDefault: true, enabled: true },
      }),
    );
    expect(snapshot?.flowVersionId).toBe('builtin-version-1');
  });

  it('连 isDefault Agent 都没有时返回 null', async () => {
    const { service, prisma } = createService();
    prisma.agent.findFirst.mockResolvedValue(null);

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      {},
    );

    expect(snapshot).toBeNull();
  });

  it('使用 StreamTask ID 幂等启动 Temporal 并保存执行标识', async () => {
    const { service, prisma, temporalClient } = createService();
    temporalClient.startWorkflow.mockResolvedValue({
      workflowId: 'task-1',
      runId: 'temporal-run-1',
    });

    const result = await service.dispatch({
      taskId: 'task-1',
      flowVersionId: 'flow-version-1',
      flowDigest: 'a'.repeat(64),
      temporalWorkflowId: null,
      temporalRunId: null,
    });

    expect(result).toEqual({
      workflowId: 'task-1',
      runId: 'temporal-run-1',
    });
    expect(temporalClient.startWorkflow).toHaveBeenCalledWith({
      streamTaskId: 'task-1',
      flowVersionId: 'flow-version-1',
      flowDigest: 'a'.repeat(64),
    });
    expect(prisma.streamTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: {
        temporalWorkflowId: 'task-1',
        temporalRunId: 'temporal-run-1',
      },
    });
  });

  it('已有 Temporal 标识的任务不会重复派发', async () => {
    const { service, prisma, temporalClient } = createService();

    const result = await service.dispatch({
      taskId: 'task-1',
      flowVersionId: 'flow-version-1',
      flowDigest: 'a'.repeat(64),
      temporalWorkflowId: 'task-1',
      temporalRunId: 'temporal-run-1',
    });

    expect(result).toBeNull();
    expect(temporalClient.startWorkflow).not.toHaveBeenCalled();
    expect(prisma.streamTask.update).not.toHaveBeenCalled();
  });

  it('未绑定 Flow 的 Agent 回落到内置直接回复 Flow', async () => {
    // 这条是方案 A 的地基：Agent 绑没绑 Flow 不再决定走哪套编排，只决定用哪张图
    const { service, prisma, builtinFlow } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      modelPreset: 'openai:gpt-5.5',
      defaultFlowVersion: null,
    });

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      {
        agentId: 'agent-1',
        isTest: true,
      },
    );

    expect(builtinFlow.findDirectVersion).toHaveBeenCalled();
    expect(snapshot).toEqual({
      flowVersionId: 'builtin-version-1',
      flowDigest: 'b'.repeat(64),
      currentStep: 'start',
    });
  });

  it('绑定了 Flow 时不去读内置 Flow', async () => {
    const { service, prisma, builtinFlow } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      modelPreset: 'openai:gpt-5.5',
      defaultFlowVersion: {
        id: 'flow-version-1',
        digest: 'a'.repeat(64),
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      },
    });

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      {
        agentId: 'agent-1',
        isTest: true,
      },
    );

    expect(builtinFlow.findDirectVersion).not.toHaveBeenCalled();
    expect(snapshot?.flowVersionId).toBe('flow-version-1');
  });

  it('内置 Flow 未初始化时显式失败，不静默回落旧链路', async () => {
    // 静默回落会让「启动时 ensure 失败」一直不被发现，而用户拿到的是一条没人知道
    // 走了哪套编排的回复
    const { service, prisma, builtinFlow } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      modelPreset: 'openai:gpt-5.5',
      defaultFlowVersion: null,
    });
    builtinFlow.findDirectVersion.mockResolvedValue(null);

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
        agentId: 'agent-1',
        isTest: true,
      }),
    ).rejects.toThrow('内置 Flow 尚未初始化');
  });

  it('Agent 不存在时返回 null，不去跑内置 Flow', async () => {
    const { service, prisma, builtinFlow } = createService();
    prisma.agent.findUnique.mockResolvedValue(null);

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      {
        agentId: 'missing',
        isTest: true,
      },
    );

    expect(snapshot).toBeNull();
    expect(builtinFlow.findDirectVersion).not.toHaveBeenCalled();
  });
});
