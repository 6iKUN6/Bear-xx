import type { ReasoningSelection } from '@litter-bear/types';
import { LlmChatModelFactory } from './chat-model.factory';
import { ReasoningContextChatOpenAICompletions } from './reasoning-context-chat-openai';
import type { LlmUpstreamFormat, ResolvedLlmTextRequest } from '../llm.types';

describe('LlmChatModelFactory reasoning mapping', () => {
  const factory = new LlmChatModelFactory({ get: () => undefined } as never);

  function request(input: {
    platform: string;
    model: string;
    upstreamFormat: LlmUpstreamFormat;
    reasoning?: ReasoningSelection;
  }): ResolvedLlmTextRequest {
    return {
      model: {
        id: `${input.platform}:${input.model}`,
        provider:
          input.upstreamFormat === 'anthropic_messages'
            ? 'anthropic'
            : input.upstreamFormat === 'gemini_generate_content'
              ? 'google'
              : 'openai',
        platform: input.platform,
        model: input.model,
        upstreamFormat: input.upstreamFormat,
        apiKey: 'test-key',
      },
      generation: {},
      reasoning: input.reasoning,
    };
  }

  it('Kimi K3 将强度映射为受控 reasoning_effort', () => {
    const model = factory.createChatModel(
      request({
        platform: 'kimi',
        model: 'kimi-k3',
        upstreamFormat: 'openai_chat_completions',
        reasoning: { effort: 'max' },
      }),
    );

    expect(model).toMatchObject({
      modelKwargs: { reasoning_effort: 'max' },
    });
  });

  it('OpenAI-compatible 使用支持回传 reasoning_content 的模型实现', () => {
    const model = factory.createChatModel(
      request({
        platform: 'deepseek',
        model: 'deepseek-v4-pro',
        upstreamFormat: 'openai_chat_completions',
      }),
    );

    expect(model).toBeInstanceOf(ReasoningContextChatOpenAICompletions);
  });

  it('DeepSeek 关闭思考时发送 thinking.type=disabled', () => {
    const model = factory.createChatModel(
      request({
        platform: 'deepseek',
        model: 'deepseek-v4-pro',
        upstreamFormat: 'openai_chat_completions',
        reasoning: { activation: 'disabled' },
      }),
    );

    expect(model).toMatchObject({
      modelKwargs: { thinking: { type: 'disabled' } },
    });
  });

  it('Anthropic 将统一配置映射为 adaptive thinking 与 effort', () => {
    const model = factory.createChatModel(
      request({
        platform: 'anthropic',
        model: 'claude-opus-5',
        upstreamFormat: 'anthropic_messages',
        reasoning: { activation: 'enabled', effort: 'xhigh' },
      }),
    );

    expect(model).toMatchObject({
      thinking: { type: 'adaptive' },
      outputConfig: { effort: 'xhigh' },
    });
  });

  it('Gemini 3 将强度映射为 thinkingLevel', () => {
    const model = factory.createChatModel(
      request({
        platform: 'google',
        model: 'gemini-3-flash-preview',
        upstreamFormat: 'gemini_generate_content',
        reasoning: { effort: 'medium' },
      }),
    );

    expect(model).toMatchObject({
      thinkingConfig: { thinkingLevel: 'MEDIUM' },
    });
  });

  it('Gemini 2.5 自动预算映射为动态预算 -1', () => {
    const model = factory.createChatModel(
      request({
        platform: 'google',
        model: 'gemini-2.5-pro',
        upstreamFormat: 'gemini_generate_content',
        reasoning: { budgetTokens: 'auto' },
      }),
    );

    expect(model).toMatchObject({
      thinkingConfig: { thinkingBudget: -1 },
    });
  });
});
