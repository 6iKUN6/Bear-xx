import { z } from 'zod';
import {
  estimateContextTokens,
  estimateNodeContextTokens,
} from './context-budget';

describe('上下文预算估算', () => {
  it('隐藏工具往返也计入输入，避免可见正文很短但请求已经超长', () => {
    const visible = { role: 'assistant' as const, content: '检索完成' };
    const plain = estimateContextTokens([visible]);
    const withTools = estimateContextTokens([
      {
        ...visible,
        modelContext: { payload: { result: '大量检索结果'.repeat(1000) } },
      },
    ]);
    expect(withTools - plain).toBeGreaterThan(5000);
  });

  it('工具 schema 占用预算，但不读取工具实例中的凭据', () => {
    const basic = {
      name: 'search',
      description: '搜索',
      schema: z.object({ query: z.string() }),
    };
    const detailed = {
      ...basic,
      schema: z.object({ query: z.string().describe('参数说明'.repeat(1000)) }),
    };
    expect(estimateNodeContextTokens('system', [detailed])).toBeGreaterThan(
      estimateNodeContextTokens('system', [basic]) + 1000,
    );
    const withCredential = {
      ...basic,
      get apiKey(): never {
        throw new Error('不应读取凭据');
      },
    };
    expect(estimateNodeContextTokens('system', [withCredential])).toBe(
      estimateNodeContextTokens('system', [basic]),
    );
  });
});
