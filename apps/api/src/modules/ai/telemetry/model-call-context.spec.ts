import {
  getModelCallCount,
  incrementModelCall,
  runWithModelCallContext,
} from './model-call-context';

describe('model-call-context', () => {
  it('accumulates increments within a context', async () => {
    const count = await runWithModelCallContext('task-1', async () => {
      await Promise.resolve();
      incrementModelCall();
      incrementModelCall();
      return getModelCallCount();
    });
    expect(count).toBe(2);
  });

  it('returns 0 outside any context', () => {
    incrementModelCall(); // 静默忽略
    expect(getModelCallCount()).toBe(0);
  });

  it('isolates counts between concurrent tasks', async () => {
    const results = await Promise.all([
      runWithModelCallContext('task-a', async () => {
        incrementModelCall();
        await new Promise((r) => setTimeout(r, 10));
        incrementModelCall();
        return getModelCallCount();
      }),
      runWithModelCallContext('task-b', async () => {
        await Promise.resolve();
        incrementModelCall();
        return getModelCallCount();
      }),
    ]);
    expect(results).toEqual([2, 1]);
  });
});
