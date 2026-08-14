import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import {
  getModelCallTokenUsage,
  getModelCallCount,
  incrementModelCall,
  recordModelCallEnd,
  recordModelCallStart,
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

  it('aggregates provider usage returned from model calls', async () => {
    const usage = await runWithModelCallContext('task-usage', async () => {
      await Promise.resolve();
      recordModelCallStart('run-1', [[new HumanMessage('你好')]]);
      recordModelCallEnd('run-1', {
        generations: [
          [
            {
              text: '你好',
              message: new AIMessage({
                content: '你好',
                usage_metadata: {
                  input_tokens: 120,
                  output_tokens: 45,
                  total_tokens: 165,
                  input_token_details: { cache_read: 80 },
                  output_token_details: { reasoning: 20 },
                },
              }),
            },
          ],
        ],
      } satisfies LLMResult);
      recordModelCallStart('run-2', [[new HumanMessage('继续')]]);
      recordModelCallEnd('run-2', {
        generations: [[]],
        llmOutput: {
          tokenUsage: {
            promptTokens: 30,
            completionTokens: 10,
            totalTokens: 40,
          },
        },
      });

      return getModelCallTokenUsage();
    });

    expect(usage).toEqual({
      inputTokens: 150,
      outputTokens: 55,
      totalTokens: 205,
      cachedInputTokens: 80,
      reasoningTokens: 20,
      estimated: false,
    });
  });

  it('uses a per-call estimate only when the provider omits usage', async () => {
    const usage = await runWithModelCallContext('task-estimate', async () => {
      await Promise.resolve();
      recordModelCallStart('run-1', [[new HumanMessage('你好')]]);
      recordModelCallEnd('run-1', {
        generations: [[{ text: '世界' }]],
      });

      return getModelCallTokenUsage();
    });

    expect(usage).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      totalTokens: 4,
      cachedInputTokens: 0,
      estimated: true,
    });
  });

  it('isolates token usage between concurrent tasks', async () => {
    const results = await Promise.all([
      runWithModelCallContext('task-a', async () => {
        recordModelCallStart('run-a', [[new HumanMessage('甲')]]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        recordModelCallEnd('run-a', {
          generations: [[]],
          llmOutput: {
            tokenUsage: {
              promptTokens: 11,
              completionTokens: 7,
              totalTokens: 18,
            },
          },
        });
        return getModelCallTokenUsage();
      }),
      runWithModelCallContext('task-b', async () => {
        await Promise.resolve();
        recordModelCallStart('run-b', [[new HumanMessage('乙')]]);
        recordModelCallEnd('run-b', {
          generations: [[]],
          llmOutput: {
            tokenUsage: {
              promptTokens: 3,
              completionTokens: 2,
              totalTokens: 5,
            },
          },
        });
        return getModelCallTokenUsage();
      }),
    ]);

    expect(results).toEqual([
      {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        cachedInputTokens: 0,
        estimated: false,
      },
      {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        cachedInputTokens: 0,
        estimated: false,
      },
    ]);
  });
});
