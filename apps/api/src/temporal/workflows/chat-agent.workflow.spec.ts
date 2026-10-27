import { ApplicationFailure } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import {
  agentFlowApprovalSignal,
  agentFlowCancelSignal,
} from './agent-flow.workflow';
import type {
  ChatAgentActivityApi,
  ChatAgentFinalizeInput,
} from './chat-agent.workflow.types';

const temporalTestServerPath = process.env.TEMPORAL_TEST_SERVER_PATH;

// 真集成测试：每个用例建两个 Worker、驱动真实 Temporal 测试服务端，与其余 suite 并行时会超过默认 5s
jest.setTimeout(30_000);

describe('chatAgentWorkflow', () => {
  let testEnvironment: TestWorkflowEnvironment | undefined;
  let workflowBundle: { code: string } | undefined;

  beforeAll(async () => {
    testEnvironment = await TestWorkflowEnvironment.createTimeSkipping(
      temporalTestServerPath
        ? {
            server: {
              executable: {
                type: 'existing-path',
                path: temporalTestServerPath,
              },
            },
          }
        : undefined,
    );
    // 打包 Worker 实际注册的入口，顺带验证两个 Workflow 能在同一个 bundle 里共存
    workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./index'),
    });
  }, 120_000);

  afterAll(async () => {
    await testEnvironment?.teardown();
  });

  it('智能体一次跑完时收敛为 completed', async () => {
    const finalized: ChatAgentFinalizeInput['status'][] = [];
    const running = await startWorkflow(
      createActivities({
        finalizeChatAgentRun: ({ status }) => {
          finalized.push(status);
          return Promise.resolve();
        },
      }),
    );
    try {
      await expect(running.handle.result()).resolves.toEqual({
        status: 'completed',
      });
      expect(finalized).toEqual(['completed']);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('等待审批 Signal 后按 approvalId 恢复，逐次处理多次审批', async () => {
    const resumed: string[] = [];
    const running = await startWorkflow(
      createActivities({
        runChatAgent: () =>
          Promise.resolve({
            kind: 'waiting_human',
            approvalId: 'approval-1',
            timeoutSeconds: 60,
          }),
        resumeChatAgent: ({ approvalId }) => {
          resumed.push(approvalId);
          return Promise.resolve(
            approvalId === 'approval-1'
              ? {
                  kind: 'waiting_human' as const,
                  approvalId: 'approval-2',
                  timeoutSeconds: 60,
                }
              : { kind: 'completed' as const },
          );
        },
      }),
    );
    try {
      await running.handle.signal(agentFlowApprovalSignal, {
        approvalId: 'approval-1',
      });
      await running.handle.signal(agentFlowApprovalSignal, {
        approvalId: 'approval-2',
      });
      await expect(running.handle.result()).resolves.toEqual({
        status: 'completed',
      });
      expect(resumed).toEqual(['approval-1', 'approval-2']);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('审批等待超时后收敛为 timed_out', async () => {
    const running = await startWorkflow(
      createActivities({
        runChatAgent: () =>
          Promise.resolve({
            kind: 'waiting_human',
            approvalId: 'approval-1',
            timeoutSeconds: 1,
          }),
      }),
    );
    try {
      await expect(running.handle.result()).resolves.toEqual({
        status: 'timed_out',
      });
    } finally {
      await stopWorkflow(running);
    }
  });

  it('等待审批期间收到取消 Signal 时收敛为 cancelled，不再恢复', async () => {
    const resumeChatAgent = jest.fn<
      ReturnType<ChatAgentActivityApi['resumeChatAgent']>,
      Parameters<ChatAgentActivityApi['resumeChatAgent']>
    >(() => Promise.resolve({ kind: 'completed' }));
    const running = await startWorkflow(
      createActivities({
        runChatAgent: () =>
          Promise.resolve({
            kind: 'waiting_human',
            approvalId: 'approval-1',
            timeoutSeconds: 600,
          }),
        resumeChatAgent,
      }),
    );
    try {
      await running.handle.signal(agentFlowCancelSignal);
      await expect(running.handle.result()).resolves.toEqual({
        status: 'cancelled',
      });
      expect(resumeChatAgent).not.toHaveBeenCalled();
    } finally {
      await stopWorkflow(running);
    }
  });

  it('智能体按预算停止时按其终态与类别收敛', async () => {
    const finalized: Array<Omit<ChatAgentFinalizeInput, 'workflow'>> = [];
    const running = await startWorkflow(
      createActivities({
        runChatAgent: () =>
          Promise.resolve({
            kind: 'stopped',
            status: 'error',
            errorCategory: 'budget_exceeded',
          }),
        finalizeChatAgentRun: ({ status, errorCategory }) => {
          finalized.push({ status, errorCategory });
          return Promise.resolve();
        },
      }),
    );
    try {
      await expect(running.handle.result()).resolves.toEqual({
        status: 'error',
      });
      expect(finalized).toEqual([
        { status: 'error', errorCategory: 'budget_exceeded' },
      ]);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('Activity 失败时把登记过的原因交给终态写入', async () => {
    const finalized: Array<Omit<ChatAgentFinalizeInput, 'workflow'>> = [];
    const running = await startWorkflow(
      createActivities({
        runChatAgent: () =>
          Promise.reject(
            ApplicationFailure.nonRetryable(
              '工具调用轮数已达上限，请缩小任务范围后重试',
              'AGENT_FLOW_CONTEXT_BUDGET_EXCEEDED',
            ),
          ),
        finalizeChatAgentRun: ({ status, errorCategory, errorReason }) => {
          finalized.push({ status, errorCategory, errorReason });
          return Promise.resolve();
        },
      }),
    );
    try {
      await running.handle.result().catch(() => undefined);
      expect(finalized).toEqual([
        {
          status: 'error',
          errorCategory: 'budget_exceeded',
          errorReason: '工具调用轮数已达上限，请缩小任务范围后重试',
        },
      ]);
    } finally {
      await stopWorkflow(running);
    }
  });

  async function startWorkflow(activities: ChatAgentActivityApi) {
    if (!testEnvironment || !workflowBundle) {
      throw new Error('Temporal 测试环境未初始化');
    }
    const orchestratorTaskQueue = `chat-agent-orchestrator-${randomUUID()}`;
    const activityTaskQueue = `chat-agent-activity-${randomUUID()}`;
    const orchestratorWorker = await Worker.create({
      connection: testEnvironment.nativeConnection,
      taskQueue: orchestratorTaskQueue,
      workflowBundle,
    });
    const activityWorker = await Worker.create({
      connection: testEnvironment.nativeConnection,
      taskQueue: activityTaskQueue,
      activities,
    });
    const workerRuns = [orchestratorWorker.run(), activityWorker.run()];
    const workflowId = `task-${randomUUID()}`;
    const handle = await testEnvironment.client.workflow.start(
      'chatAgentWorkflow',
      {
        taskQueue: orchestratorTaskQueue,
        workflowId,
        args: [{ streamTaskId: workflowId, activityTaskQueue }],
      },
    );
    return {
      handle,
      workers: [orchestratorWorker, activityWorker],
      workerRuns,
    };
  }

  /** 先请求优雅停止，再等待轮询循环退出，防止 Jest 保留活动句柄。 */
  async function stopWorkflow(running: {
    workers: Worker[];
    workerRuns: Promise<void>[];
  }): Promise<void> {
    for (const worker of running.workers) {
      worker.shutdown();
    }
    await Promise.all(running.workerRuns);
  }
});

/** 构造默认智能体 Activity 替身：默认一次跑完。 */
function createActivities(
  overrides: Partial<ChatAgentActivityApi> = {},
): ChatAgentActivityApi {
  return {
    runChatAgent:
      overrides.runChatAgent ?? (() => Promise.resolve({ kind: 'completed' })),
    resumeChatAgent:
      overrides.resumeChatAgent ??
      (() => Promise.resolve({ kind: 'completed' })),
    finalizeChatAgentRun:
      overrides.finalizeChatAgentRun ?? (() => Promise.resolve()),
  };
}
