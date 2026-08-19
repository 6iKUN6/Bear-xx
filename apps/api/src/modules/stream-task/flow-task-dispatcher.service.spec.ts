import { AgentFlowVersionStatus } from '@prisma/client';
import { createFlowDefinitionPreset } from '../agent-flow/definition/flow-definition.templates';
import { FlowTaskDispatcherService } from './flow-task-dispatcher.service';

describe('FlowTaskDispatcherService', () => {
  function createService() {
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
      ),
      prisma,
      temporalClient,
    };
  }

  it('仅为测试会话锁定 Agent 已发布 FlowVersion', async () => {
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue({
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
