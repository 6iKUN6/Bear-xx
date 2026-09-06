import { AIMessage, ToolMessage } from '@langchain/core/messages';

import { extractModelContext, replayModelContext } from './model-context';
import {
  modelContextEnvelopeSchema,
  type ModelContextIdentity,
} from './model-context.schema';

const identity: ModelContextIdentity = {
  providerKey: 'kimi',
  upstreamFormat: 'openai_chat_completions',
  model: 'kimi-k3',
  reasoningFingerprint: 'a'.repeat(64),
  policy: 'full-tool-transcript',
};

describe('model context', () => {
  it('严格 schema 拒绝信封和 payload 的额外字段', () => {
    expect(() =>
      modelContextEnvelopeSchema.parse({
        version: 1,
        ...identity,
        extra: true,
        payload: { messages: [], extra: true },
      }),
    ).toThrow();
  });

  it('提取并回放 OpenAI-compatible reasoning 与完整工具往返', () => {
    const context = extractModelContext(
      [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 'call-1', name: 'place_order', args: { sku: 'meal-1' } },
          ],
          additional_kwargs: { reasoning_content: 'private-reasoning' },
        }),
        new ToolMessage({
          content: '{"orderId":"order-1"}',
          tool_call_id: 'call-1',
          name: 'place_order',
        }),
        new AIMessage({
          content: '订单已创建',
          additional_kwargs: { reasoning_content: 'final-private-reasoning' },
        }),
      ],
      identity,
    );

    expect(context).toMatchObject({
      policy: 'full-tool-transcript',
      payload: { messages: expect.any(Array) },
    });
    const replayed = replayModelContext(context, identity);
    expect(replayed).toHaveLength(3);
    expect(replayed?.[0]).toMatchObject({
      type: 'ai',
      additional_kwargs: { reasoning_content: 'private-reasoning' },
      tool_calls: [{ id: 'call-1', name: 'place_order' }],
    });
    expect(replayed?.[1]).toMatchObject({
      type: 'tool',
      tool_call_id: 'call-1',
    });
  });

  it.each([
    ['providerKey', 'deepseek'],
    ['upstreamFormat', 'anthropic_messages'],
    ['model', 'kimi-k2.6'],
    ['reasoningFingerprint', 'b'.repeat(64)],
  ] as const)('%s 不一致时不回放', (field, value) => {
    const context = extractModelContext(
      [
        new AIMessage({
          content: '回答',
          additional_kwargs: { reasoning_content: 'private' },
        }),
      ],
      identity,
    );

    expect(replayModelContext(context, { ...identity, [field]: value })).toBe(
      undefined,
    );
  });

  it('Gemini thoughtSignature 会原样进入回放消息', () => {
    const geminiIdentity: ModelContextIdentity = {
      providerKey: 'google',
      upstreamFormat: 'gemini_generate_content',
      model: 'gemini-3-flash-preview',
      reasoningFingerprint: 'c'.repeat(64),
      policy: 'thought-signature',
    };
    const context = extractModelContext(
      [
        new AIMessage({
          content: [
            { type: 'thinking', thinking: 'private', signature: 'sig-think' },
          ],
          tool_calls: [{ id: 'call-1', name: 'lookup', args: { query: 'x' } }],
          additional_kwargs: {
            __gemini_function_call_thought_signatures__: {
              'call-1': 'sig-tool',
            },
          },
        }),
      ],
      geminiIdentity,
    );

    expect(replayModelContext(context, geminiIdentity)?.[0]).toMatchObject({
      content: [
        { type: 'thinking', thinking: 'private', signature: 'sig-think' },
      ],
      additional_kwargs: {
        __gemini_function_call_thought_signatures__: {
          'call-1': 'sig-tool',
        },
      },
    });
  });
});
