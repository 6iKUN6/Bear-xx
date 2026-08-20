import { ApplicationFailure } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
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

// 本文件是真集成测试：每个用例要建两个 Worker、驱动真实 Temporal 服务端跑完整
// workflow。与其余五十多个 suite 并行抢 CPU 时，单用例稳定超过 jest 默认的 5s。
jest.setTimeout(30_000);

describe('agentFlowWorkflow', () => {
  let testEnvironment: TestWorkflowEnvironment | undefined;
  let workflowBundle: { code: string } | undefined;

  // 整个 suite 共用一个测试服务端：每个用例起一个的话，本文件要拉起九次 Temporal
  // 服务端，与其余 suite 并行时会抢端口并间歇性 Connection refused。用例之间的隔离
  // 靠 startWorkflow 里 randomUUID 的任务队列与 workflowId，本来就不依赖服务端隔离；
  // 时间跳跃只在所有 workflow 都阻塞时推进，而 jest 在同一 suite 内串行执行用例。
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
    // 只打包一次 workflow：Worker.create({ workflowsPath }) 每次都会跑一遍 webpack
    // （约 1.5MB 产物、数秒），本文件九个用例各建两个 Worker，重复打包会让单用例
    // 轻易超过 jest 默认 5s 超时。
    workflowBundle = await bundleWorkflowCode({
      workflowsPath: require.resolve('./agent-flow.workflow'),
    });
  }, 120_000);

  afterAll(async () => {
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

  it('原生取消时仍写入 cancelled 终态，不把任务留在运行中', async () => {
    const finalized: Array<{ status: string; lastNodeKey: string | null }> = [];
    let enterSnapshot!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => {
      enterSnapshot = resolve;
    });
    let releaseSnapshot!: () => void;
    const snapshotReleased = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const running = await startWorkflow({
      ...createActivities({
        snapshot: approvalSnapshot(),
        finalizeRun: ({ status, lastNodeKey }) => {
          finalized.push({ status, lastNodeKey });
          return Promise.resolve();
        },
      }),
      // 在第一个 Activity 中挂住，确保取消请求落在 Workflow 已开始执行之后；
      // proxyActivities 默认 TRY_CANCEL，取消一到 Workflow 侧 Promise 立即 reject。
      loadRunSnapshot: async () => {
        enterSnapshot();
        await snapshotReleased;
        return approvalSnapshot();
      },
    });

    try {
      await snapshotEntered;
      await running.handle.cancel();

      // 未走 nonCancellable 时终态写入会被一并取消，finalized 为空、任务永远停在 RUNNING
      await expect(running.handle.result()).rejects.toThrow();
      expect(finalized).toEqual([{ status: 'cancelled', lastNodeKey: null }]);
    } finally {
      releaseSnapshot();
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
      await expectWorkflowFailedBecause(
        running.handle.result(),
        '不可恢复的节点错误',
      );
      expect(attempts).toBe(1);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('节点返回 continued 时逐步调度同一节点，每步一次 Activity', async () => {
    const scheduled: string[] = [];
    let continueCalls = 0;
    const running = await startWorkflow(
      createActivities({
        snapshot: singleNodeSnapshot(),
        executeNode: ({ nodeKey }) => {
          scheduled.push(`execute:${nodeKey}`);
          return Promise.resolve({ kind: 'continued', completedSteps: 1 });
        },
        continueNode: ({ nodeKey }) => {
          continueCalls += 1;
          scheduled.push(`continue:${nodeKey}`);
          // 前两次继续推进，第三次收敛为完成
          return Promise.resolve(
            continueCalls < 3
              ? { kind: 'continued', completedSteps: continueCalls + 1 }
              : { kind: 'completed', outcome: 'default' },
          );
        },
        finalizeRun: () => Promise.resolve(),
      }),
    );

    try {
      await expect(running.handle.result()).resolves.toEqual({
        status: 'completed',
        lastNodeKey: 'answer',
      });
      // 一次 executeNode 起头，其后每步各一次 continueNode，均落在同一节点上
      expect(scheduled).toEqual([
        'execute:answer',
        'continue:answer',
        'continue:answer',
        'continue:answer',
      ]);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('continued 未推进步骤时拒绝空转并终止 Flow', async () => {
    const finalized: Array<{ status: string }> = [];
    const running = await startWorkflow(
      createActivities({
        snapshot: singleNodeSnapshot(),
        // 始终返回同一个 completedSteps，模拟 Activity 卡在同一步不前进
        executeNode: () =>
          Promise.resolve({ kind: 'continued', completedSteps: 2 }),
        continueNode: () =>
          Promise.resolve({ kind: 'continued', completedSteps: 2 }),
        finalizeRun: ({ status }) => {
          finalized.push({ status });
          return Promise.resolve();
        },
      }),
    );

    try {
      await expectWorkflowFailedBecause(running.handle.result(), '拒绝空转');
      expect(finalized).toEqual([{ status: 'error' }]);
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
    if (!workflowBundle) {
      throw new Error('Workflow 打包产物未初始化');
    }
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

  it('Activity 抛出的失败原因与类别传给终态写入，不再泛化成通用错误', async () => {
    // 曾硬编码 errorCategory='WORKFLOW_ACTIVITY_FAILED'（还不在协议闭集内）并丢弃 message，
    // 用户只剩一句「流程执行失败」，真实原因只能靠翻 worker 日志
    const finalized: Array<{
      status: string;
      errorCategory?: string;
      errorReason?: string;
    }> = [];
    const running = await startWorkflow(
      createActivities({
        snapshot: singleNodeSnapshot(),
        executeNode: () =>
          Promise.reject(
            ApplicationFailure.nonRetryable(
              'Flow 任务未锁定智能体默认模型',
              'AGENT_FLOW_RUNTIME_CONTEXT_INVALID',
            ),
          ),
        finalizeRun: ({ status, errorCategory, errorReason }) => {
          finalized.push({ status, errorCategory, errorReason });
          return Promise.resolve();
        },
      }),
    );

    try {
      await expectWorkflowFailedBecause(
        running.handle.result(),
        '未锁定智能体默认模型',
      );
      expect(finalized).toEqual([
        {
          status: 'error',
          // 配置问题归 invalid：归成 server 会让前端建议「稍后重试」，而重试不会变好
          errorCategory: 'invalid',
          errorReason: 'Flow 任务未锁定智能体默认模型',
        },
      ]);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('非 ApplicationFailure 异常不透出 message，避免带出连接串或密钥', async () => {
    const finalized: Array<{ errorCategory?: string; errorReason?: string }> =
      [];
    const running = await startWorkflow(
      createActivities({
        snapshot: singleNodeSnapshot(),
        executeNode: () =>
          Promise.reject(
            new Error('connect ECONNREFUSED postgres://user:pw@db:5432'),
          ),
        finalizeRun: ({ errorCategory, errorReason }) => {
          finalized.push({ errorCategory, errorReason });
          return Promise.resolve();
        },
      }),
    );

    try {
      await running.handle.result().catch(() => undefined);
      expect(finalized).toHaveLength(1);
      expect(finalized[0].errorCategory).toBe('server');
      expect(finalized[0].errorReason).toBeUndefined();
    } finally {
      await stopWorkflow(running);
    }
  });

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
/**
 * 断言 Workflow 因指定原因失败
 * @param result Workflow Handle 的 result Promise
 * @param reason 期望出现在失败原因中的文案
 * @returns 无返回值
 * @description handle.result() 拒绝的是 WorkflowFailedError，其 message 恒为通用的
 * "Workflow execution failed"，真实原因在 cause 上。直接对 message 断言会让任何失败
 * 原因都通过，因此必须沿 cause 链取实际失败信息。
 */
async function expectWorkflowFailedBecause(
  result: Promise<unknown>,
  reason: string,
): Promise<void> {
  const failure = await result.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  const causes: string[] = [];
  let current: unknown = failure;
  while (current instanceof Error) {
    causes.push(current.message);
    current = current.cause;
  }
  expect(causes.join(' | ')).toContain(reason);
}

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
    continueNode:
      overrides.continueNode ??
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
