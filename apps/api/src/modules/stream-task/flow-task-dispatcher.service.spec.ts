import { AgentFlowVersionStatus, Prisma } from '@prisma/client';
import { createFlowDefinitionPreset } from '../agent-flow/definition/flow-definition.templates';
import { FlowTaskDispatcherService } from './flow-task-dispatcher.service';

describe('FlowTaskDispatcherService', () => {
  function agentModelConfig(presetId: string | null) {
    return {
      defaultModelPreset: presetId ? { presetId } : null,
      defaultReasoningConfig: null,
      allowedModelPresets: presetId
        ? [
            {
              modelPreset: {
                presetId,
                enabled: true,
                connection: { enabled: true },
              },
            },
          ]
        : [],
    };
  }

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
    const modelRegistry = {
      normalizePresetReasoning: jest.fn(
        (_presetId: string, selection: unknown) => selection,
      ),
    };

    return {
      service: new FlowTaskDispatcherService(
        prisma as never,
        temporalClient as never,
        runtimeValidator as never,
        builtinFlow as never,
        modelRegistry as never,
      ),
      prisma,
      temporalClient,
      runtimeValidator,
      builtinFlow,
      modelRegistry,
    };
  }

  it('仅为测试会话锁定 Agent 已发布 FlowVersion', async () => {
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      ...agentModelConfig('openai:gpt-5.5'),
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
      agentId: 'agent-1',
      resolvedAgentModelPresetId: 'openai:gpt-5.5',
      resolvedAgentReasoningConfig: Prisma.JsonNull,
    });
  });

  it('智能体未配模型预设时在创建任务期就拒绝，不派发出去', async () => {
    // 内置模板的节点都写 agent-default，只有到任务锁定期才能解析成具体预设。
    // 不在这里拦，任务会被派发并在 Temporal Activity 里以
    // AGENT_FLOW_RUNTIME_CONTEXT_INVALID 死掉，用户只看到一句「流程执行失败」
    const { service, prisma, runtimeValidator } = createService(false);
    prisma.agent.findUnique.mockResolvedValue({
      ...agentModelConfig(null),
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
    ).rejects.toThrow('当前智能体尚未配置默认模型');

    expect(runtimeValidator.validate).not.toHaveBeenCalled();
  });

  it('本条消息选择允许集合中的模型并锁定到任务快照', async () => {
    const { service, prisma, runtimeValidator, modelRegistry } =
      createService();
    modelRegistry.normalizePresetReasoning.mockReturnValue({ effort: 'high' });
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      defaultModelPreset: { presetId: 'model-default' },
      defaultReasoningConfig: {
        version: 1,
        selection: { effort: 'low' },
      },
      allowedModelPresets: [
        {
          modelPreset: {
            presetId: 'model-default',
            enabled: true,
            connection: { enabled: true },
          },
        },
        {
          modelPreset: {
            presetId: 'model-selected',
            enabled: true,
            connection: { enabled: true },
          },
        },
      ],
      defaultFlowVersion: {
        id: 'flow-version-1',
        digest: 'a'.repeat(64),
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      },
    });

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      { agentId: 'agent-1', selectedModelPresetId: 'model-selected' },
    );

    expect(snapshot.resolvedAgentModelPresetId).toBe('model-selected');
    expect(snapshot.resolvedAgentReasoningConfig).toEqual({
      version: 1,
      selection: { effort: 'high' },
    });
    expect(modelRegistry.normalizePresetReasoning).toHaveBeenCalledWith(
      'model-selected',
      undefined,
      { applyDefault: true },
    );
    expect(runtimeValidator.validate).toHaveBeenCalledWith(expect.anything(), {
      phase: 'task',
      agentDefaultModelPreset: 'model-selected',
      agentDefaultReasoning: { effort: 'high' },
    });
  });

  it('拒绝选择 Agent 允许集合之外的模型', async () => {
    const { service, prisma, runtimeValidator } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      ...agentModelConfig('model-default'),
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
        selectedModelPresetId: 'model-outside',
      }),
    ).rejects.toThrow('不在当前智能体允许集合中');
    expect(runtimeValidator.validate).not.toHaveBeenCalled();
  });

  it('Flow 全部使用显式模型时拒绝无效的终端模型覆盖', async () => {
    const { service, prisma } = createService();
    const direct = createFlowDefinitionPreset('direct');
    const explicit = {
      ...direct,
      nodes: direct.nodes.map((node) =>
        node.type === 'agent'
          ? {
              ...node,
              config: { ...node.config, modelPreset: 'model-explicit' },
            }
          : node,
      ),
    };
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      ...agentModelConfig(null),
      defaultFlowVersion: {
        id: 'flow-version-1',
        digest: 'a'.repeat(64),
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: explicit,
      },
    });

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
        agentId: 'agent-1',
        selectedModelPresetId: 'model-selected',
      }),
    ).rejects.toThrow('当前 Flow 不使用 agent-default');
  });

  it('普通聊天同样走 Flow，不再有 isTest 闸门', async () => {
    // 这条替代了原先的「普通聊天不查询 FlowVersion」：Flow 已是唯一编排路径
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      ...agentModelConfig('openai:gpt-5.5'),
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
      id: 'default-agent-id',
      ...agentModelConfig('openai:gpt-5.5'),
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
    // 回落到的 Agent 必须回传，调用方要把它写进 StreamTask 与助手消息。只在解析时
    // 用、不写回去，任务上的 agentId 就是 null，Activity 会以快照不一致失败——
    // 历史上没有 defaultAgentId 的会话就是这样断的
    expect(snapshot?.agentId).toBe('default-agent-id');
  });

  it('连 isDefault Agent 都没有时明确失败', async () => {
    // 返回 null 会让任务落回已被废弃的旧编排链路，那是一条不可达的路；而「系统一个
    // 可用智能体都没有」本就是必须立刻发现的配置事故
    const { service, prisma } = createService();
    prisma.agent.findFirst.mockResolvedValue(null);

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {}),
    ).rejects.toThrow('系统未配置可用的默认智能体');
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
      id: 'agent-1',
      ...agentModelConfig('openai:gpt-5.5'),
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
      agentId: 'agent-1',
      resolvedAgentModelPresetId: 'openai:gpt-5.5',
      resolvedAgentReasoningConfig: Prisma.JsonNull,
    });
  });

  it('绑定了 Flow 时不去读内置 Flow', async () => {
    const { service, prisma, builtinFlow } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      ...agentModelConfig('openai:gpt-5.5'),
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
      id: 'agent-1',
      ...agentModelConfig('openai:gpt-5.5'),
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

  it('指定的 Agent 不存在时明确失败，不去跑内置 Flow', async () => {
    const { service, prisma, builtinFlow } = createService();
    prisma.agent.findUnique.mockResolvedValue(null);

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
        agentId: 'missing',
      }),
    ).rejects.toThrow('指定的智能体不存在或已停用');
    expect(builtinFlow.findDirectVersion).not.toHaveBeenCalled();
  });
});
