import {
  AgentFlowVersionStatus,
  Prisma,
  StreamTaskRuntime,
} from '@prisma/client';
import { createFlowDefinitionPreset } from '../agent-flow/definition/flow-definition.templates';
import { calculateFlowDefinitionDigest } from '../agent-flow/definition/flow-definition.digest';
import { FlowTaskDispatcherService } from './flow-task-dispatcher.service';

describe('FlowTaskDispatcherService', () => {
  it('任务锁定失败时直接返回可操作的配置错误，不派发到 Worker', async () => {
    const { service, prisma, runtimeValidator, temporalClient } =
      createService();
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      ...agentModelConfig('model-enabled'),
      defaultFlowVersion: {
        id: 'flow-version-1',
        digest: directDigest,
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      },
    });
    runtimeValidator.validate.mockReturnValue({
      valid: false,
      errors: [
        {
          path: 'nodes.1.config.modelPreset',
          rule: 'model-context-limits',
          message: '请在后台为模型「测试模型」配置上下文容量',
        },
      ],
    });

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
        agentId: 'agent-1',
      }),
    ).rejects.toThrow('请在后台为模型「测试模型」配置上下文容量');
    expect(temporalClient.startWorkflow).not.toHaveBeenCalled();
  });

  const directDigest = calculateFlowDefinitionDigest(
    createFlowDefinitionPreset('direct'),
  );
  function agentModelConfig(
    presetId: string | null,
    toolGroups: string[] = [],
  ) {
    return {
      toolGroups,
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
      startChatAgentWorkflow: jest.fn(),
    };
    const modelRegistry = {
      normalizePresetReasoning: jest.fn(
        (_presetId: string, selection: unknown) => selection,
      ),
      getVisionTransport: jest.fn(),
      getCapability: jest.fn<string | undefined, [string]>(() => 'tools'),
    };

    return {
      service: new FlowTaskDispatcherService(
        prisma as never,
        temporalClient as never,
        runtimeValidator as never,
        modelRegistry as never,
      ),
      prisma,
      temporalClient,
      runtimeValidator,
      modelRegistry,
    };
  }

  it('图片任务要求所有最终回答节点命中视觉能力闭集', async () => {
    const { service, prisma, modelRegistry } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      ...agentModelConfig('openai:gpt-5.6-sol'),
      defaultFlowVersion: {
        id: 'flow-version-1',
        digest: directDigest,
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      },
    });
    modelRegistry.getVisionTransport.mockReturnValue('public_url');

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
        agentId: 'agent-1',
        requiresVision: true,
      }),
    ).resolves.toMatchObject({
      resolvedAgentModelPresetId: 'openai:gpt-5.6-sol',
    });
    expect(modelRegistry.getVisionTransport).toHaveBeenCalledWith(
      'openai:gpt-5.6-sol',
    );
  });

  it('图片任务在最终回答模型不支持视觉时创建前拒绝', async () => {
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      ...agentModelConfig('deepseek:chat'),
      defaultFlowVersion: {
        id: 'flow-version-1',
        digest: directDigest,
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      },
    });

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
        agentId: 'agent-1',
        requiresVision: true,
      }),
    ).rejects.toThrow('使用的模型不支持图片输入');
  });

  it('仅为测试会话锁定 Agent 已发布 FlowVersion', async () => {
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      ...agentModelConfig('openai:gpt-5.5'),
      defaultFlowVersion: {
        id: 'flow-version-1',
        digest: directDigest,
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      },
    });

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      { agentId: 'agent-1' },
    );

    expect(snapshot).toEqual({
      runtime: StreamTaskRuntime.AGENT_FLOW,
      flowVersionId: 'flow-version-1',
      flowDigest: directDigest,
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
        digest: directDigest,
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      },
    });

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
        agentId: 'agent-1',
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
        digest: directDigest,
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
        digest: directDigest,
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
        digest: calculateFlowDefinitionDigest(explicit),
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
    expect(snapshot.runtime).toBe(StreamTaskRuntime.CHAT_AGENT);
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
      runtime: StreamTaskRuntime.AGENT_FLOW,
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
      runtime: StreamTaskRuntime.AGENT_FLOW,
      flowVersionId: 'flow-version-1',
      flowDigest: 'a'.repeat(64),
      temporalWorkflowId: 'task-1',
      temporalRunId: 'temporal-run-1',
    });

    expect(result).toBeNull();
    expect(temporalClient.startWorkflow).not.toHaveBeenCalled();
    expect(prisma.streamTask.update).not.toHaveBeenCalled();
  });

  it('绑定了 Flow 时锁定该版本并交给 agentFlowWorkflow', async () => {
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      ...agentModelConfig('openai:gpt-5.5'),
      defaultFlowVersion: {
        id: 'flow-version-1',
        digest: directDigest,
        status: AgentFlowVersionStatus.PUBLISHED,
        definition: createFlowDefinitionPreset('direct'),
      },
    });

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      {
        agentId: 'agent-1',
      },
    );

    expect(snapshot).toMatchObject({
      runtime: StreamTaskRuntime.AGENT_FLOW,
      flowVersionId: 'flow-version-1',
    });
  });

  it('任务创建前拒绝 Definition 与已发布摘要不一致的工件', async () => {
    const { service, prisma, runtimeValidator } = createService();
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

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
        agentId: 'agent-1',
      }),
    ).rejects.toThrow('摘要与 Definition 不一致');
    expect(runtimeValidator.validate).not.toHaveBeenCalled();
  });

  it('指定的 Agent 不存在时明确失败', async () => {
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue(null);

    await expect(
      service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
        agentId: 'missing',
      }),
    ).rejects.toThrow('指定的智能体不存在或已停用');
  });

  describe('未绑定 Flow：默认 ReAct 智能体', () => {
    it('锁定模型、思考与工具组，不经过 Flow 校验', async () => {
      const { service, prisma, runtimeValidator } = createService();
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        ...agentModelConfig('openai:gpt-5.5', ['weather', 'search']),
        defaultFlowVersion: null,
      });

      const snapshot = await service.resolveTaskFlowSnapshot(
        { agent: prisma.agent } as never,
        { agentId: 'agent-1' },
      );

      expect(snapshot).toEqual({
        runtime: StreamTaskRuntime.CHAT_AGENT,
        currentStep: 'chat',
        agentId: 'agent-1',
        resolvedAgentModelPresetId: 'openai:gpt-5.5',
        resolvedAgentReasoningConfig: Prisma.JsonNull,
        resolvedAgentToolGroups: ['weather', 'search'],
        agentToolsDegraded: false,
      });
      expect(runtimeValidator.validate).not.toHaveBeenCalled();
    });

    it('模型未通过工具探测时锁空工具组并标记降级，而不是拒绝任务', async () => {
      const { service, prisma, modelRegistry } = createService();
      modelRegistry.getCapability.mockReturnValue('basic');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        ...agentModelConfig('deepseek:chat', ['weather']),
        defaultFlowVersion: null,
      });

      const snapshot = await service.resolveTaskFlowSnapshot(
        { agent: prisma.agent } as never,
        { agentId: 'agent-1' },
      );

      expect(snapshot).toMatchObject({
        resolvedAgentToolGroups: [],
        agentToolsDegraded: true,
      });
    });

    it('没有配置工具时不算降级', async () => {
      const { service, prisma, modelRegistry } = createService();
      modelRegistry.getCapability.mockReturnValue('basic');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        ...agentModelConfig('deepseek:chat'),
        defaultFlowVersion: null,
      });

      await expect(
        service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
          agentId: 'agent-1',
        }),
      ).resolves.toMatchObject({ agentToolsDegraded: false });
    });

    it('允许本轮选择模型与覆盖思考参数', async () => {
      const { service, prisma, modelRegistry } = createService();
      modelRegistry.normalizePresetReasoning.mockReturnValue({
        effort: 'high',
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        ...agentModelConfig('model-selected'),
        defaultModelPreset: { presetId: 'model-default' },
        defaultFlowVersion: null,
      });

      const snapshot = await service.resolveTaskFlowSnapshot(
        { agent: prisma.agent } as never,
        {
          agentId: 'agent-1',
          selectedModelPresetId: 'model-selected',
          reasoning: { effort: 'high' },
        },
      );

      expect(snapshot.resolvedAgentModelPresetId).toBe('model-selected');
      expect(snapshot.resolvedAgentReasoningConfig).toEqual({
        version: 1,
        selection: { effort: 'high' },
      });
    });

    it('图片任务的锁定模型不支持视觉时创建前拒绝', async () => {
      const { service, prisma, modelRegistry } = createService();
      modelRegistry.getVisionTransport.mockReturnValue(undefined);
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        ...agentModelConfig('deepseek:chat'),
        defaultFlowVersion: null,
      });

      await expect(
        service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
          agentId: 'agent-1',
          requiresVision: true,
        }),
      ).rejects.toThrow('不支持图片输入');
    });

    it('未配置默认模型时明确拒绝', async () => {
      const { service, prisma } = createService();
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        ...agentModelConfig(null),
        defaultFlowVersion: null,
      });

      await expect(
        service.resolveTaskFlowSnapshot({ agent: prisma.agent } as never, {
          agentId: 'agent-1',
        }),
      ).rejects.toThrow('当前智能体尚未配置默认模型');
    });

    it('派发到 chatAgentWorkflow 并保存执行标识', async () => {
      const { service, prisma, temporalClient } = createService();
      temporalClient.startChatAgentWorkflow.mockResolvedValue({
        workflowId: 'task-1',
        runId: 'temporal-run-1',
      });

      await service.dispatch({
        taskId: 'task-1',
        runtime: StreamTaskRuntime.CHAT_AGENT,
        flowVersionId: null,
        flowDigest: null,
        temporalWorkflowId: null,
        temporalRunId: null,
      });

      expect(temporalClient.startChatAgentWorkflow).toHaveBeenCalledWith({
        streamTaskId: 'task-1',
      });
      expect(temporalClient.startWorkflow).not.toHaveBeenCalled();
      expect(prisma.streamTask.update).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: {
          temporalWorkflowId: 'task-1',
          temporalRunId: 'temporal-run-1',
        },
      });
    });
  });
});
