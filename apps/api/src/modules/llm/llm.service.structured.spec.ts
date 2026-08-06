import { z } from 'zod';
import type { ConfigService } from '@nestjs/config';
import { LlmService } from './llm.service';
import type { LlmModelRegistryService } from './llm-model-registry.service';
import type { LlmChatModelFactory } from './providers/chat-model.factory';

/**
 * generateStructured 单测：覆盖「原生结构化输出 → 提示词降级 → 全失败返回 null」三条路径，
 * 以及两条路径都必须过 schema 校验这一核心约束。不触达真实网络。
 */
describe('LlmService.generateStructured', () => {
  const schema = z.object({
    agentId: z.string().min(1),
    reason: z.string().optional(),
  });

  /**
   * 构造 LlmService
   * @param opts structured=原生结构化输出的行为；text=降级路径 invoke 返回的裸文本
   */
  function createService(opts: { structured?: () => unknown; text?: string }) {
    const invoke = jest.fn(() => {
      return Promise.resolve({ content: opts.text ?? '' });
    });
    const withStructuredOutput = jest.fn(() => ({
      invoke: jest.fn(() => {
        if (!opts.structured) {
          return Promise.reject(new Error('structured output unsupported'));
        }
        return Promise.resolve(opts.structured());
      }),
    }));

    const chatModelFactory = {
      createChatModel: () => ({ invoke, withStructuredOutput }),
    } as unknown as LlmChatModelFactory;

    const modelRegistry = {
      resolveTextRequest: () => ({
        model: { id: 'm', platform: 'p', provider: 'openai', model: 'gpt' },
        generation: {},
      }),
    } as unknown as LlmModelRegistryService;

    const configService = {
      get: () => undefined,
    } as unknown as ConfigService;

    return {
      service: new LlmService(modelRegistry, chatModelFactory, configService),
      withStructuredOutput,
      invoke,
    };
  }

  const messages = [{ role: 'user' as const, content: '选一个' }];

  it('原生结构化输出可用：直接返回校验后的结果', async () => {
    const { service, withStructuredOutput, invoke } = createService({
      structured: () => ({ agentId: 'a1', reason: '合适' }),
    });

    const result = await service.generateStructured(messages, schema, {
      schemaName: 'group_route',
    });

    expect(result).toEqual({ agentId: 'a1', reason: '合适' });
    expect(withStructuredOutput).toHaveBeenCalled();
    // 原生路径成功时不应再走降级的裸文本调用
    expect(invoke).not.toHaveBeenCalled();
  });

  it('原生结构化输出结果不合规：也要被 schema 拦下并转降级', async () => {
    // 原生返回缺 agentId → schema 校验失败 → 走降级，降级给出合法结果
    const { service, invoke } = createService({
      structured: () => ({ reason: '没有 agentId' }),
      text: '{"agentId":"a2"}',
    });

    const result = await service.generateStructured(messages, schema);

    expect(result).toEqual({ agentId: 'a2' });
    expect(invoke).toHaveBeenCalled();
  });

  it('provider 不支持结构化输出：降级到提示词并从杂文中提取 JSON', async () => {
    const { service, invoke } = createService({
      text: '好的：\n```json\n{"agentId":"a3","reason":"降级也可用"}\n```',
    });

    const result = await service.generateStructured(messages, schema);

    expect(result).toEqual({ agentId: 'a3', reason: '降级也可用' });
    expect(invoke).toHaveBeenCalled();
  });

  it('降级路径输出不合规：返回 null 而非放行非法结果', async () => {
    const { service } = createService({ text: '{"reason":"缺少 agentId"}' });
    await expect(
      service.generateStructured(messages, schema),
    ).resolves.toBeNull();
  });

  it('降级路径无法解析：返回 null', async () => {
    const { service } = createService({ text: '我不知道该选谁' });
    await expect(
      service.generateStructured(messages, schema),
    ).resolves.toBeNull();
  });
});
