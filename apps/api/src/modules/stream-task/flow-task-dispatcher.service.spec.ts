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
      },
      streamTask: {
        update: jest.fn(),
      },
    };
    const temporalClient = {
      startWorkflow: jest.fn(),
    };

    return {
      service: new FlowTaskDispatcherService(
        prisma as never,
        temporalClient as never,
        runtimeValidator as never,
      ),
      prisma,
      temporalClient,
      runtimeValidator,
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
      currentStep: 'answer',
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

  it('普通聊天不会查询或锁定 FlowVersion', async () => {
    const { service, prisma } = createService();

    const snapshot = await service.resolveTaskFlowSnapshot(
      { agent: prisma.agent } as never,
      { agentId: 'agent-1', isTest: false },
    );

    expect(snapshot).toBeNull();
    expect(prisma.agent.findUnique).not.toHaveBeenCalled();
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
});
