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

  it('幂等键带轮次段，且节点生命周期内始终一致', async () => {
    // issue #9 第 2 步。两件事都要成立，缺一不可：
    //   1. 键里带轮次 —— 否则循环第二轮写入撞 (taskId, nodeExecutionId) 唯一键，而
    //      replayFinishedNode 更会直接回放第一轮结果，让循环静默退化成只跑一轮
    //   2. 同一节点的 execute / continue / resume 必须拿到**同一个**键 —— 否则 Temporal
    //      重试会绕过幂等短路，把已放行的工具再执行一遍
    const seen: string[] = [];
    let continueCalls = 0;
    const running = await startWorkflow(
      createActivities({
        snapshot: singleNodeSnapshot(),
        executeNode: ({ nodeExecutionId }) => {
          seen.push(nodeExecutionId);
          return Promise.resolve({ kind: 'continued', completedSteps: 1 });
        },
        continueNode: ({ nodeExecutionId }) => {
          seen.push(nodeExecutionId);
          continueCalls += 1;
          return Promise.resolve(
            continueCalls < 2
              ? { kind: 'continued', completedSteps: continueCalls + 1 }
              : { kind: 'completed', outcome: 'default' },
          );
        },
        finalizeRun: () => Promise.resolve(),
      }),
    );

    try {
      await running.handle.result();
      // 非循环节点固定属于第 0 轮
      expect(seen[0]).toMatch(/#0$/);
      // 整个节点生命周期共用同一个键
      expect(new Set(seen).size).toBe(1);
      expect(seen).toHaveLength(3);
    } finally {
      await stopWorkflow(running);
    }
  });

  it('loop 会执行第 2 轮，且同一轮 Activity 重试保持完全相同的幂等身份', async () => {
    const seen: Array<{
      nodeKey: string;
      iteration: number;
      nodeExecutionId: string;
    }> = [];
    let firstBodyAttempts = 0;
    const running = await startWorkflow(
      createActivities({
        snapshot: loopParallelSnapshot(),
        executeNode: (input) => {
          seen.push({
            nodeKey: input.nodeKey,
            iteration: input.iteration,
            nodeExecutionId: input.nodeExecutionId,
          });
          if (input.nodeKey === 'lp') {
            return Promise.resolve({
              kind: 'completed' as const,
              outcome: input.iteration < 2 ? 'again' : 'done',
            });
          }
          if (input.nodeKey === 'body_entry' && input.iteration === 1) {
            firstBodyAttempts += 1;
            if (firstBodyAttempts === 1) {
              return Promise.reject(
                ApplicationFailure.retryable('临时失败', 'TEST_RETRYABLE'),
              );
            }
          }
          return Promise.resolve({ kind: 'completed', outcome: 'default' });
        },
        finalizeRun: () => Promise.resolve(),
      }),
    );

    try {
      await expect(running.handle.result()).resolves.toMatchObject({
        status: 'completed',
        lastNodeKey: 'tail',
      });
      const bodyEntries = seen.filter((item) => item.nodeKey === 'body_entry');
      expect(bodyEntries.map((item) => item.iteration)).toEqual([1, 1, 2]);
      expect(bodyEntries.map((item) => item.nodeExecutionId)).toEqual([
        expect.stringMatching(/:body_entry#1$/),
        expect.stringMatching(/:body_entry#1$/),
        expect.stringMatching(/:body_entry#2$/),
      ]);
      expect(
        seen
          .filter((item) => item.nodeKey === 'lp')
          .map((item) => item.iteration),
      ).toEqual([0, 1, 2]);
      for (const member of ['branch_a', 'branch_b', 'merge']) {
        expect(
          seen
            .filter((item) => item.nodeKey === member)
            .map((item) => item.iteration),
        ).toEqual([1, 2]);
      }
    } finally {
      await stopWorkflow(running);
    }
  });

  it('不收敛的 loop 在体内节点撞到预算后停止扩展下一轮', async () => {
    const seen: string[] = [];
    const finalized: Array<{ status: string; errorCategory?: string }> = [];
    const running = await startWorkflow(
      createActivities({
        snapshot: loopParallelSnapshot(),
        executeNode: ({ nodeKey, iteration }) => {
          seen.push(`${nodeKey}#${iteration}`);
          if (nodeKey === 'lp') {
            return Promise.resolve({
              kind: 'completed' as const,
              outcome: 'again',
            });
          }
          if (nodeKey === 'body_entry' && iteration === 2) {
            return Promise.resolve({
              kind: 'stopped' as const,
              status: 'error' as const,
              errorCategory: 'budget_exceeded' as const,
            });
          }
          return Promise.resolve({ kind: 'completed', outcome: 'default' });
        },
        finalizeRun: ({ status, errorCategory }) => {
          finalized.push({ status, errorCategory });
          return Promise.resolve();
        },
      }),
    );

    try {
      await expect(running.handle.result()).resolves.toMatchObject({
        status: 'error',
      });
      expect(finalized).toEqual([
        { status: 'error', errorCategory: 'budget_exceeded' },
      ]);
      expect(seen).toContain('body_entry#2');
      expect(seen.some((item) => item.endsWith('#3'))).toBe(false);
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
  it('扇出的两条分支并发执行，join(all) 等齐后才继续', async () => {
    // 关键断言是「并发」而不只是「都跑了」：单游标执行器也会把两个节点都跑一遍，
    // 但那是串行。用「第二个节点开始时第一个还没结束」来区分。
    const started: string[] = [];
    const finished: string[] = [];
    let releaseBranches: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBranches = resolve;
    });
    const order: string[] = [];

    const { handle } = await startWorkflow({
      loadRunSnapshot: () => Promise.resolve(parallelSnapshot('all')),
      executeNode: async ({ nodeKey }) => {
        started.push(nodeKey);
        order.push(`start:${nodeKey}`);
        if (nodeKey === 'branch_a' || nodeKey === 'branch_b') {
          // 两条分支互相等待：只有真并发才能同时到达这里，串行执行会死等
          if (started.filter((key) => key !== 'start').length >= 2) {
            releaseBranches?.();
          }
          await bothStarted;
        }
        finished.push(nodeKey);
        order.push(`done:${nodeKey}`);
        return { kind: 'completed', outcome: 'default' };
      },
      continueNode: () => Promise.reject(new Error('不应被调用')),
      resumeNode: () => Promise.reject(new Error('不应被调用')),
      finalizeRun: () => Promise.resolve(),
    });

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
    });
    // 两条分支都在对方结束前就已开始 —— 这才是并发
    const aStart = order.indexOf('start:branch_a');
    const bStart = order.indexOf('start:branch_b');
    const aDone = order.indexOf('done:branch_a');
    const bDone = order.indexOf('done:branch_b');
    expect(bStart).toBeLessThan(aDone);
    expect(aStart).toBeLessThan(bDone);
    // join 在两条分支都完成之后才跑
    expect(order.indexOf('start:merge')).toBeGreaterThan(
      Math.max(aDone, bDone),
    );
    expect(started).toContain('tail');
  });

  it('join(all) 必须等齐慢分支才继续', async () => {
    // 与 any 那条对称，用同一张图只换 policy。判据是 merge 必须在慢分支结束之后才开始——
    // 这能区分 gate 是否真的生效：gate 失效时 merge 会在快分支一落地就启动。
    const order: string[] = [];
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const { handle } = await startWorkflow({
      loadRunSnapshot: () => Promise.resolve(parallelSnapshot('all')),
      executeNode: async ({ nodeKey }) => {
        order.push(`start:${nodeKey}`);
        if (nodeKey === 'branch_a') {
          // 快分支落地后放闸，让慢分支得以完成
          releaseSlow?.();
        }
        if (nodeKey === 'branch_b') {
          await slowGate;
        }
        order.push(`done:${nodeKey}`);
        return { kind: 'completed', outcome: 'default' };
      },
      continueNode: () => Promise.reject(new Error('不应被调用')),
      resumeNode: () => Promise.reject(new Error('不应被调用')),
      finalizeRun: () => Promise.resolve(),
    });

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
    });
    expect(order.indexOf('start:merge')).toBeGreaterThan(
      order.indexOf('done:branch_b'),
    );
    expect(order.indexOf('start:merge')).toBeGreaterThan(
      order.indexOf('done:branch_a'),
    );
  });

  it('join(any) 不等慢分支就继续后继', async () => {
    // 真正的判据是顺序：tail 必须在 branch_b 结束**之前**就开始。
    // 用 Promise.all 逐轮收口的实现会让 any 退化成 all，这条就会失败。
    const order: string[] = [];
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const { handle } = await startWorkflow({
      loadRunSnapshot: () => Promise.resolve(parallelSnapshot('any')),
      executeNode: async ({ nodeKey }) => {
        order.push(`start:${nodeKey}`);
        if (nodeKey === 'branch_b') {
          await slowGate;
        }
        if (nodeKey === 'tail') {
          // 后继已经开始，说明没等慢分支；放掉它让 workflow 收尾
          releaseSlow?.();
        }
        order.push(`done:${nodeKey}`);
        return { kind: 'completed', outcome: 'default' };
      },
      continueNode: () => Promise.reject(new Error('不应被调用')),
      resumeNode: () => Promise.reject(new Error('不应被调用')),
      finalizeRun: () => Promise.resolve(),
    });

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
    });
    expect(order.indexOf('start:tail')).toBeGreaterThan(-1);
    expect(order.indexOf('start:tail')).toBeLessThan(
      order.indexOf('done:branch_b'),
    );
  });

  it('一条分支停止时先等其余分支跑完，再收敛终态', async () => {
    // 不掀桌：在飞分支的副作用已经发生，中途放弃会让事件序与预算账目对不上
    const finished: string[] = [];

    const { handle } = await startWorkflow({
      loadRunSnapshot: () => Promise.resolve(parallelSnapshot('all')),
      executeNode: ({ nodeKey }) => {
        finished.push(nodeKey);
        if (nodeKey === 'branch_a') {
          return Promise.resolve({
            kind: 'stopped' as const,
            status: 'error' as const,
            errorCategory: 'budget_exceeded' as const,
          });
        }
        return Promise.resolve({
          kind: 'completed' as const,
          outcome: 'default',
        });
      },
      continueNode: () => Promise.reject(new Error('不应被调用')),
      resumeNode: () => Promise.reject(new Error('不应被调用')),
      finalizeRun: () => Promise.resolve(),
    });

    await expect(handle.result()).resolves.toMatchObject({ status: 'error' });
    // 另一条分支照样跑完了，没有被第一个 stopped 掀掉
    expect(finished).toContain('branch_b');
    // join 与后继不再进入前沿
    expect(finished).not.toContain('merge');
    expect(finished).not.toContain('tail');
  });

  /**
   * 构造扇出 + join 的运行快照
   * @param policy join 的等待策略
   * @returns 返回 Workflow 可直接消费的脱敏快照
   */
  function parallelSnapshot(policy: 'all' | 'any'): AgentFlowRunSnapshot {
    return {
      entryNodeKey: 'start',
      maxDurationSeconds: 600,
      nodes: [
        {
          key: 'start',
          type: 'start',
          next: { default: ['branch_a', 'branch_b'] },
        },
        { key: 'branch_a', type: 'agent', next: { default: ['merge'] } },
        { key: 'branch_b', type: 'agent', next: { default: ['merge'] } },
        {
          key: 'merge',
          type: 'join',
          next: { default: ['tail'] },
          join: { waitFor: ['branch_a', 'branch_b'], policy },
        },
        { key: 'tail', type: 'synthesize', next: {} },
      ],
    };
  }

  /**
   * 构造含并行循环体与 join(all) 的运行快照
   * @returns 返回可验证多轮重入、轮次身份与 join 重置的脱敏快照
   * @description body_entry 每轮扇出两条分支，merge 必须等齐后才能通过唯一回边回到 lp。
   */
  function loopParallelSnapshot(): AgentFlowRunSnapshot {
    return {
      entryNodeKey: 'start',
      maxDurationSeconds: 600,
      nodes: [
        { key: 'start', type: 'start', next: { default: ['lp'] } },
        {
          key: 'lp',
          type: 'loop',
          next: { again: ['body_entry'], done: ['tail'] },
          loop: {
            body: ['body_entry', 'branch_a', 'branch_b', 'merge'],
          },
        },
        {
          key: 'body_entry',
          type: 'agent',
          next: { default: ['branch_a', 'branch_b'] },
        },
        { key: 'branch_a', type: 'agent', next: { default: ['merge'] } },
        { key: 'branch_b', type: 'agent', next: { default: ['merge'] } },
        {
          key: 'merge',
          type: 'join',
          next: { default: ['lp'] },
          join: { waitFor: ['branch_a', 'branch_b'], policy: 'all' },
        },
        { key: 'tail', type: 'synthesize', next: {} },
      ],
    };
  }

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

  it('模型超时直接收敛为可重试的 timeout 错误', async () => {
    const finalized: Array<{
      errorCategory?: string;
      errorReason?: string;
    }> = [];
    const running = await startWorkflow(
      createActivities({
        snapshot: singleNodeSnapshot(),
        executeNode: () =>
          Promise.reject(
            ApplicationFailure.nonRetryable(
              '模型响应超时，请重试',
              'AGENT_FLOW_LLM_TIMEOUT',
            ),
          ),
        finalizeRun: ({ errorCategory, errorReason }) => {
          finalized.push({ errorCategory, errorReason });
          return Promise.resolve();
        },
      }),
    );

    try {
      await running.handle.result().catch(() => undefined);
      expect(finalized).toEqual([
        {
          errorCategory: 'timeout',
          errorReason: '模型响应超时，请重试',
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
        next: { approved: ['answer'] },
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
