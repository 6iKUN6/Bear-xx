import { findModelVisionTransport } from './model-vision.catalog';

describe('model vision catalog', () => {
  it.each([
    ['kimi', 'openai_chat_completions', 'kimi-k3', 'data_uri'],
    ['kimi-coding', 'openai_chat_completions', 'k3', 'data_uri'],
    ['kimi-coding', 'openai_chat_completions', 'k3-256k', 'data_uri'],
    ['openai', 'openai_responses', 'gpt-5.6-sol', 'public_url'],
    ['openai', 'openai_responses', 'gpt-5.6-terra', 'public_url'],
    ['openai', 'openai_responses', 'gpt-5.6-luna', 'public_url'],
  ] as const)('%s/%s/%s 使用 %s', (platform, format, model, transport) => {
    expect(findModelVisionTransport(platform, format, model)).toBe(transport);
  });

  it('同名模型使用错误供应商或协议时不继承视觉能力', () => {
    expect(
      findModelVisionTransport('custom-openai', 'openai_responses', 'k3'),
    ).toBeUndefined();
    expect(
      findModelVisionTransport(
        'openai',
        'openai_chat_completions',
        'gpt-5.6-sol',
      ),
    ).toBeUndefined();
  });
});
