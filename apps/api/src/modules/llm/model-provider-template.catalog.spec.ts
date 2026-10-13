import { BadRequestException } from '@nestjs/common';
import {
  assertProviderAllowsUpstreamFormat,
  applyModelTokenDefaults,
  MODEL_PROVIDER_TEMPLATES,
  normalizeModelProviderBaseUrl,
  requireModelProviderTemplate,
} from './model-provider-template.catalog';

describe('model provider template catalog', () => {
  it('所有模板预算合法，K3 使用业务输出默认值而非总容量', () => {
    for (const template of MODEL_PROVIDER_TEMPLATES) {
      for (const model of template.recommendedModels) {
        if (model.contextWindowTokens !== null) {
          expect(model.contextWindowTokens).toBeGreaterThanOrEqual(2048);
          if (model.maxOutputTokens !== null) {
            expect(model.maxOutputTokens).toBeLessThan(
              model.contextWindowTokens,
            );
          }
        }
      }
    }
    expect(applyModelTokenDefaults('kimi', { model: 'kimi-k3' })).toEqual({
      model: 'kimi-k3',
      contextWindowTokens: 1048576,
      maxOutputTokens: 131072,
    });
  });

  it('只按精确型号补缺省值，保留自定义值和未知额度', () => {
    expect(
      applyModelTokenDefaults('deepseek', { model: 'deepseek-v4-flash' }),
    ).toEqual({
      model: 'deepseek-v4-flash',
      contextWindowTokens: 1048576,
      maxOutputTokens: 384000,
    });
    expect(
      applyModelTokenDefaults('deepseek', {
        model: 'deepseek-v4-flash',
        contextWindowTokens: 64000,
        maxOutputTokens: null,
      }),
    ).toEqual({
      model: 'deepseek-v4-flash',
      contextWindowTokens: 64000,
      maxOutputTokens: null,
    });
    expect(
      applyModelTokenDefaults('kimi-coding', { model: 'k3-256k' })
        .maxOutputTokens,
    ).toBeNull();
    expect(
      applyModelTokenDefaults('deepseek', {
        model: 'deepseek-v4.1-flash-expires-on-0910',
      }).contextWindowTokens,
    ).toBeNull();
  });

  it('DeepSeek 模板使用 Chat Completions 根地址', () => {
    const template = requireModelProviderTemplate('deepseek');

    expect(template.defaultBaseURL).toBe('https://api.deepseek.com/v1');
    expect(template.allowedUpstreamFormats).toEqual([
      'openai_chat_completions',
    ]);
  });

  it('Gemini 模板只开放原生 generateContent 协议', () => {
    const template = requireModelProviderTemplate('google');

    expect(template.allowedUpstreamFormats).toEqual([
      'gemini_generate_content',
    ]);
  });

  it('拒绝供应商模板不支持的上游协议', () => {
    expect(() =>
      assertProviderAllowsUpstreamFormat('deepseek', 'openai_responses'),
    ).toThrow(BadRequestException);
  });

  it('规范化根地址末尾斜杠', () => {
    expect(normalizeModelProviderBaseUrl('https://api.deepseek.com/v1/')).toBe(
      'https://api.deepseek.com/v1',
    );
  });

  it.each([
    'https://api.deepseek.com/v1/chat/completions',
    'https://api.openai.com/v1/responses',
    'https://api.anthropic.com/v1/messages',
  ])('拒绝把完整请求端点当成 baseURL：%s', (url) => {
    expect(() => normalizeModelProviderBaseUrl(url)).toThrow(
      '应填写 API 根地址',
    );
  });

  it('拒绝未知供应商和非 HTTP 协议', () => {
    expect(() => requireModelProviderTemplate('unknown')).toThrow(
      BadRequestException,
    );
    expect(() => normalizeModelProviderBaseUrl('file:///tmp/model')).toThrow(
      '只支持 http 或 https',
    );
  });
});
