import { buildRenderVideoObjectKey } from './render-object-key';
import {
  RENDER_WORKER_ROLE_ERROR,
  assertRenderWorkerRole,
} from './render-worker-role';

describe('渲染产物对象 key', () => {
  it('测试任务使用稳定的 dev 目录，普通任务不受影响', () => {
    const identity = {
      taskId: 'task-1',
      nodeExecutionId: 'task-1:version-1:render#0',
    };
    const production = buildRenderVideoObjectKey({
      ...identity,
      isTest: false,
    });
    const testing = buildRenderVideoObjectKey({ ...identity, isTest: true });

    expect(testing).toBe(`dev/${production}`);
    expect(buildRenderVideoObjectKey({ ...identity, isTest: true })).toBe(
      testing,
    );
  });

  it('同一任务同一轮次永远得到同一个 key', () => {
    const first = buildRenderVideoObjectKey({
      isTest: false,
      taskId: 'task-1',
      nodeExecutionId: 'task-1:version-1:render#0',
    });
    const second = buildRenderVideoObjectKey({
      isTest: false,
      taskId: 'task-1',
      nodeExecutionId: 'task-1:version-1:render#0',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^video\/task-1\/[a-f0-9]{64}\.mp4$/);
  });

  it('下一轮次换成新的 key，同轮重试才复用', () => {
    const round0 = buildRenderVideoObjectKey({
      isTest: false,
      taskId: 'task-1',
      nodeExecutionId: 'task-1:version-1:render#0',
    });
    const round1 = buildRenderVideoObjectKey({
      isTest: false,
      taskId: 'task-1',
      nodeExecutionId: 'task-1:version-1:render#1',
    });

    expect(round1).not.toBe(round0);
  });

  it('合法最长节点名不会挤掉轮次或末尾字符', () => {
    const taskId = 'a'.repeat(36);
    const prefix = `${taskId}:${'b'.repeat(36)}:${'n'.repeat(63)}`;
    const keys = [`${prefix}a#1`, `${prefix}a#2`, `${prefix}b#1`].map(
      (nodeExecutionId) =>
        buildRenderVideoObjectKey({ taskId, nodeExecutionId, isTest: false }),
    );

    expect(new Set(keys).size).toBe(3);
  });

  it('字符折叠相同的执行标识仍使用不同对象', () => {
    const keys = ['a:b#0', 'a-b-0', 'a/b/0'].map((nodeExecutionId) =>
      buildRenderVideoObjectKey({
        taskId: 'task-1',
        nodeExecutionId,
        isTest: false,
      }),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it('标识里的分隔符与路径片段被折叠，无法改变目录结构', () => {
    const key = buildRenderVideoObjectKey({
      isTest: false,
      taskId: '../task-1',
      nodeExecutionId: 'a/../../b',
    });

    // 目录层级只能来自服务自己拼的 `video/`，标识里的斜杠被折叠掉，无法多出一级
    const segments = key.split('/');
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe('video');
    expect(segments.slice(1)).not.toContain('..');
  });

  it('标识折叠后为空时直接失败，不生成会撞车的 key', () => {
    expect(() =>
      buildRenderVideoObjectKey({
        taskId: '///',
        nodeExecutionId: '###',
        isTest: false,
      }),
    ).toThrow('渲染对象 key 的任务标识或节点执行标识为空');
  });
});

describe('渲染 Activity 的角色约束', () => {
  it('activity 角色允许渲染', () => {
    expect(() =>
      assertRenderWorkerRole({ TEMPORAL_WORKER_ROLE: 'activity' }),
    ).not.toThrow();
  });

  it.each([
    ['orchestrator', { TEMPORAL_WORKER_ROLE: 'orchestrator' }],
    ['未设置', {}],
    ['未知角色', { TEMPORAL_WORKER_ROLE: 'api' }],
  ])('%s 角色拒绝渲染', (_label, environment) => {
    expect(() => assertRenderWorkerRole(environment)).toThrow(
      '渲染节点只允许在 TEMPORAL_WORKER_ROLE=activity 的 Activity Worker 中执行',
    );
    try {
      assertRenderWorkerRole(environment);
    } catch (error) {
      expect((error as Error).name).toBe(RENDER_WORKER_ROLE_ERROR);
    }
  });
});
