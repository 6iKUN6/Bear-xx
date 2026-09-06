import { BadRequestException } from '@nestjs/common';
import { MODEL_PROVIDER_TEMPLATES } from './model-provider-template.catalog';
import {
  MODEL_REASONING_CATALOG,
  findModelReasoningCapability,
  normalizeReasoningSelection,
} from './model-reasoning.catalog';

describe('model reasoning catalog', () => {
  it('目录键唯一，且每条记录都属于推荐模型的精确三元组', () => {
    const keys = MODEL_REASONING_CATALOG.map((entry) =>
      [entry.providerKey, entry.upstreamFormat, entry.model].join(':'),
    );
    expect(new Set(keys).size).toBe(keys.length);

    const recommendedKeys = new Set(
      MODEL_PROVIDER_TEMPLATES.flatMap((template) =>
        template.recommendedModels.map((model) =>
          [template.providerKey, model.upstreamFormat, model.model].join(':'),
        ),
      ),
    );
    for (const key of keys) {
      expect(recommendedKeys).toContain(key);
    }
  });

  it('不会根据模型名称推断未知或代理模型能力', () => {
    expect(
      findModelReasoningCapability(
        'custom-openai',
        'openai_chat_completions',
        'kimi-k3',
      ),
    ).toBeUndefined();
    expect(() =>
      normalizeReasoningSelection(
        'custom-openai',
        'openai_chat_completions',
        'kimi-k3',
        { effort: 'high' },
      ),
    ).toThrow(BadRequestException);
  });

  it('为可调模型补齐目录默认值，并拒绝不支持的档位', () => {
    expect(
      normalizeReasoningSelection(
        'kimi',
        'openai_chat_completions',
        'kimi-k3',
        undefined,
      ),
    ).toEqual({ effort: 'max' });
    expect(() =>
      normalizeReasoningSelection(
        'kimi',
        'openai_chat_completions',
        'kimi-k3',
        { effort: 'medium' },
      ),
    ).toThrow('不支持的思考强度');
  });

  it('关闭思考时拒绝残留 effort 或预算', () => {
    expect(() =>
      normalizeReasoningSelection(
        'deepseek',
        'openai_chat_completions',
        'deepseek-v4-pro',
        { activation: 'disabled', effort: 'high' },
      ),
    ).toThrow('关闭思考时不能同时配置');
  });

  it('Flow 显式模式要求提交全部可调字段', () => {
    expect(() =>
      normalizeReasoningSelection(
        'deepseek',
        'openai_chat_completions',
        'deepseek-v4-pro',
        { activation: 'enabled' },
        { requireExplicit: true },
      ),
    ).toThrow('思考强度必须显式配置');
  });

  it('Anthropic 手动思考预算必须小于最大输出 token', () => {
    expect(() =>
      normalizeReasoningSelection(
        'anthropic',
        'anthropic_messages',
        'claude-haiku-4-5',
        { activation: 'enabled', budgetTokens: 4096 },
        { generation: { maxOutputTokens: 4096 } },
      ),
    ).toThrow('必须小于最大输出 token');
  });

  it('开启 DeepSeek 思考时拒绝会被上游忽略的采样参数', () => {
    expect(() =>
      normalizeReasoningSelection(
        'deepseek',
        'openai_chat_completions',
        'deepseek-v4-pro',
        { activation: 'enabled', effort: 'high' },
        { generation: { temperature: 0.7 } },
      ),
    ).toThrow('不允许设置 temperature');
  });
});
