import { ApplicationFailure } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import type {
  AgentFlowActivityApi,
  AgentFlowRunSnapshot,
  AgentFlowWorkflowResult,
} from './agent-flow.workflow.types';
import {
  agentFlowApprovalSignal,
  agentFlowCancelSignal,
  type AgentFlowWorkflowInput,
} from './agent-flow.workflow';

type TestAgentFlowWorkflow = (
  input: AgentFlowWorkflowInput,
) => Promise<AgentFlowWorkflowResult>;

const temporalTestServerPath = process.env.TEMPORAL_TEST_SERVER_PATH;
const describeTimeSkippingWorkflow =
  process.arch === 'arm64' && !temporalTestServerPath
    ? describe.skip
    : describe;

describeTimeSkippingWorkflow('agentFlowWorkflow', () => {
  let testEnvironment: TestWorkflowEnvironment | undefined;

  beforeEach(async () => {
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
  });

  afterEach(async () => {
    await testEnvironment?.teardown();
  });

  it('收到只含 approvalId 的审批 Signal 后恢复原节点并完成 Flow', async () => {
    const finalized: Array<{ status: string; lastNodeKey: string | null }> = [];
    const running = await startWorkflow(
      createActivities({
        snapshot: approvalSnapshot(),
        executeNode: ({ nodeKey }) =>
          Promise.resolve(
            nodeKey === 'review'
              ? {
                  kind: 'waiting_human' as const,
                  approvalId: 'approval-1',
                  timeoutSeconds: 60,
                }
              : { kind: 'completed' as const, outcome: 'default' as const },
          ),
        resumeNode: () =>
          Promise.resolve({ kind: 'completed', outcome: 'approved' }),
        finalizeRun: ({ status, lastNodeKey }) => {
          finalized.push({ status, lastNodeKey });
          return Promise.resolve();
        },
      }),
    );

    try {
      await running.handle.signal(agentFlowApprovalSignal, {
        approvalId: 'approval-1',
      });

      await expect(running.handle.result()).resolves.toEqual({
        status: 'completed',
        lastNodeKey: 'answer',
      });
      expect(finalized).toEqual([
        { status: 'completed', lastNodeKey: 'answer' },
      ]);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('审批等待超时后收敛为明确的 timed_out 终态', async () => {
    const finalized: Array<{ status: string; lastNodeKey: string | null }> = [];
    const running = await startWorkflow(
      createActivities({
        snapshot: approvalSnapshot(),
        executeNode: () =>
          Promise.resolve({
            kind: 'waiting_human',
            approvalId: 'approval-timeout',
            timeoutSeconds: 1,
          }),
        resumeNode: () =>
          Promise.resolve({ kind: 'completed', outcome: 'approved' }),
        finalizeRun: ({ status, lastNodeKey }) => {
          finalized.push({ status, lastNodeKey });
          return Promise.resolve();
        },
      }),
    );

    try {
      await expect(running.handle.result()).resolves.toEqual({
        status: 'timed_out',
        lastNodeKey: 'review',
      });
      expect(finalized).toEqual([
        { status: 'timed_out', lastNodeKey: 'review' },
      ]);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('同一节点连续等待多个 approvalId 时逐次恢复，不复用旧决定', async () => {
    let resumeAttempts = 0;
    const running = await startWorkflow(
      createActivities({
        snapshot: approvalSnapshot(),
        executeNode: ({ nodeKey }) =>
          Promise.resolve(
            nodeKey === 'review'
              ? {
                  kind: 'waiting_human' as const,
                  approvalId: 'approval-first',
                  timeoutSeconds: 60,
                }
              : { kind: 'completed' as const, outcome: 'default' as const },
          ),
        resumeNode: () => {
          resumeAttempts += 1;
          return Promise.resolve(
            resumeAttempts === 1
              ? {
                  kind: 'waiting_human' as const,
                  approvalId: 'approval-second',
                  timeoutSeconds: 60,
                }
              : { kind: 'completed' as const, outcome: 'approved' as const },
          );
        },
        finalizeRun: () => Promise.resolve(),
      }),
    );

    try {
      await running.handle.signal(agentFlowApprovalSignal, {
        approvalId: 'approval-first',
      });
      await running.handle.signal(agentFlowApprovalSignal, {
        approvalId: 'approval-second',
      });

      await expect(running.handle.result()).resolves.toEqual({
        status: 'completed',
        lastNodeKey: 'answer',
      });
      expect(resumeAttempts).toBe(2);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('收到取消 Signal 后不再执行后续节点', async () => {
    const executedNodeKeys: string[] = [];
    const running = await startWorkflow(
      createActivities({
        snapshot: approvalSnapshot(),
        executeNode: ({ nodeKey }) => {
          executedNodeKeys.push(nodeKey);
          return Promise.resolve({
            kind: 'waiting_human',
            approvalId: 'approval-cancel',
            timeoutSeconds: 60,
          });
        },
        resumeNode: () =>
          Promise.resolve({ kind: 'completed', outcome: 'approved' }),
        finalizeRun: () => Promise.resolve(),
      }),
    );

    try {
      await running.handle.signal(agentFlowCancelSignal);

      await expect(running.handle.result()).resolves.toEqual({
        status: 'cancelled',
        lastNodeKey: null,
      });
      expect(executedNodeKeys).toEqual([]);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('可重试 Activity 在有限次数内成功后继续推进', async () => {
    let attempts = 0;
    const running = await startWorkflow(
      createActivities({
        snapshot: singleNodeSnapshot(),
        executeNode: () => {
          attempts += 1;
          if (attempts < 3) {
            return Promise.reject(
              ApplicationFailure.retryable('临时失败', 'TEST_RETRYABLE'),
            );
          }
          return Promise.resolve({ kind: 'completed', outcome: 'default' });
        },
        resumeNode: () =>
          Promise.resolve({ kind: 'completed', outcome: 'approved' }),
        finalizeRun: () => Promise.resolve(),
      }),
    );

    try {
      await expect(running.handle.result()).resolves.toEqual({
        status: 'completed',
        lastNodeKey: 'answer',
      });
      expect(attempts).toBe(3);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('不可重试 Activity 只执行一次并将错误暴露给 Temporal', async () => {
    let attempts = 0;
    const running = await startWorkflow(
      createActivities({
        snapshot: singleNodeSnapshot(),
        executeNode: () => {
          attempts += 1;
          return Promise.reject(
            ApplicationFailure.nonRetryable(
              '不可恢复的节点错误',
              'AGENT_FLOW_NON_RETRYABLE',
            ),
          );
        },
        resumeNode: () =>
          Promise.resolve({ kind: 'completed', outcome: 'approved' }),
        finalizeRun: () => Promise.resolve(),
      }),
    );

    try {
      await expect(running.handle.result()).rejects.toThrow(
        '不可恢复的节点错误',
      );
      expect(attempts).toBe(1);
    } finally {
      await stopWorkflow(running);
    }
  });

  /**
   * 创建连接到 Temporal 测试环境的 Workflow 与 Activity Worker
   * @param activities 测试替身 Activity 集合
   * @returns 返回 Workflow Handle、Worker 和运行 Promise
   * @description 每个测试使用独立队列，避免 Signal、Activity 重试次数或时间跳跃相互污染。
   */
  async function startWorkflow(activities: AgentFlowActivityApi) {
    if (!testEnvironment) {
      throw new Error('Temporal 测试环境未初始化');
    }
    const orchestratorTaskQueue = `agent-flow-orchestrator-${randomUUID()}`;
    const activityTaskQueue = `agent-flow-activity-${randomUUID()}`;
    const orchestratorWorker = await Worker.create({
      connection: testEnvironment.nativeConnection,
      taskQueue: orchestratorTaskQueue,
      workflowsPath: require.resolve('./agent-flow.workflow'),
    });
    const activityWorker = await Worker.create({
      connection: testEnvironment.nativeConnection,
      taskQueue: activityTaskQueue,
      activities,
    });
    const workerRuns = [orchestratorWorker.run(), activityWorker.run()];
    const workflowId = `task-${randomUUID()}`;
    const input: AgentFlowWorkflowInput = {
      streamTaskId: workflowId,
      flowVersionId: 'flow-version-1',
      flowDigest: 'a'.repeat(64),
      activityTaskQueue,
    };
    const handle = await testEnvironment.client.workflow.start(
      'agentFlowWorkflow' as TestAgentFlowWorkflow,
      {
        taskQueue: orchestratorTaskQueue,
        workflowId,
        args: [input],
      },
    );

    return {
      handle,
      workers: [orchestratorWorker, activityWorker],
      workerRuns,
    };
  }

  /**
   * 停止测试 Worker
   * @param running 由 startWorkflow 创建的运行资源
   * @returns 无返回值
   * @description 先请求优雅停止，再等待轮询循环退出，防止 Jest 保留活动句柄。
   */
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

/**
 * 构造最小的 Activity 替身
 * @param overrides 覆盖默认 Activity 行为的测试实现
 * @returns 返回可注册到 Temporal Worker 的完整 Activity 集合
 * @description 默认实现只服务测试；真实 Activity 只在独立 Activity Worker 进程中访问数据库和 Nest 服务。
 */
function createActivities(
  overrides: Partial<AgentFlowActivityApi> & {
    snapshot: AgentFlowRunSnapshot;
  },
): AgentFlowActivityApi {
  return {
    loadRunSnapshot: () => Promise.resolve(overrides.snapshot),
    executeNode:
      overrides.executeNode ??
      (() => Promise.resolve({ kind: 'completed', outcome: 'default' })),
    resumeNode:
      overrides.resumeNode ??
      (() => Promise.resolve({ kind: 'completed', outcome: 'default' })),
    finalizeRun: overrides.finalizeRun ?? (() => Promise.resolve()),
  };
}

/**
 * 创建包含审批节点的最小执行快照
 * @returns 返回只含结构化节点与分支的脱敏快照
 * @description Workflow History 只需要节点键、节点类型与受限边，不保存完整 FlowDefinition 或会话内容。
 */
function approvalSnapshot(): AgentFlowRunSnapshot {
  return {
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
  };
}

/**
 * 创建无审批的单节点执行快照
 * @returns 返回仅用于 Activity 重试测试的快照
 * @description 将重试测试聚焦在 Activity policy，避免分支与人工等待影响断言。
 */
function singleNodeSnapshot(): AgentFlowRunSnapshot {
  return {
    entryNodeKey: 'answer',
    maxDurationSeconds: 60,
    nodes: [{ key: 'answer', type: 'synthesize', next: {} }],
  };
}
