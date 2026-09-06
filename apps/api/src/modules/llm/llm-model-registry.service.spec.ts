import {
  ModelPresetCapability,
  ModelProviderConnectionStatus,
  ModelUpstreamFormat,
} from '@prisma/client';
import { LlmCredentialCryptoService } from './llm-credential-crypto.service';
import { LlmModelRegistryService } from './llm-model-registry.service';

describe('LlmModelRegistryService', () => {
  const encryptionKey = Buffer.alloc(32, 3).toString('base64');
  const crypto = new LlmCredentialCryptoService({
    get: () => encryptionKey,
  } as never);

  /**
   * 构造一行模型预设
   * @param overrides 需要覆盖的字段
   * @returns 返回与 Prisma 行同形的对象
   */
  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'row-1',
      connectionId: 'connection-1',
      presetId: 'openai:gpt-5.5',
      name: 'GPT-5.5',
      description: '',
      model: 'gpt-5.5',
      upstreamFormat: ModelUpstreamFormat.OPENAI_CHAT_COMPLETIONS,
      temperature: null,
      maxOutputTokens: null,
      topP: null,
      enabled: true,
      isDefault: true,
      capability: ModelPresetCapability.TOOLS,
      lastCheckedAt: null,
      lastCheckError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      connection: {
        id: 'connection-1',
        connectionKey: 'openai-main',
        providerKey: 'openai',
        name: 'OpenAI 官方',
        baseURL: 'https://api.openai.com/v1',
        enabled: true,
        apiKeyCiphertext: crypto.encrypt('sk-live-secret'),
        apiKeyFingerprint: crypto.fingerprint('sk-live-secret'),
        status: ModelProviderConnectionStatus.REACHABLE,
        lastCheckedAt: null,
        lastCheckError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ...overrides,
    };
  }

  /**
   * 构造已完成加载的注册表
   * @param rows 数据库返回的预设行
   * @returns 返回注册表与 findMany 替身
   */
  async function createRegistry(rows: Array<ReturnType<typeof row>>) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const registry = new LlmModelRegistryService(
      { modelPreset: { findMany } } as never,
      crypto,
    );
    await registry.onModuleInit();
    return { registry, findMany };
  }

  it('对外列表不含 apiKey，只给脱敏 hint', async () => {
    const { registry } = await createRegistry([row()]);

    const [summary] = registry.listAvailableModels();

    // 回归护栏：此前 listAvailableModels 直接返回内部预设，env 层预设带明文 key
    expect(JSON.stringify(summary)).not.toContain('sk-live-secret');
    expect(summary).not.toHaveProperty('apiKey');
    expect(summary).toEqual(
      expect.objectContaining({
        name: 'GPT-5.5',
        connectionName: 'OpenAI 官方',
      }),
    );
    expect(summary.apiKeyHint).toBe(
      crypto.toDisplayHint(crypto.fingerprint('sk-live-secret')),
    );
  });

  it('解析请求时解密 apiKey，并由上游格式推导 provider', async () => {
    const { registry } = await createRegistry([
      row({ upstreamFormat: ModelUpstreamFormat.ANTHROPIC_MESSAGES }),
    ]);

    const resolved = registry.resolveTextRequest();

    expect(resolved.model.apiKey).toBe('sk-live-secret');
    expect(resolved.model.upstreamFormat).toBe('anthropic_messages');
    expect(resolved.model.provider).toBe('anthropic');
  });

  it('Responses 格式的预设解析为 openai provider', async () => {
    const { registry } = await createRegistry([
      row({ upstreamFormat: ModelUpstreamFormat.OPENAI_RESPONSES }),
    ]);

    const resolved = registry.resolveTextRequest();

    expect(resolved.model.upstreamFormat).toBe('openai_responses');
    expect(resolved.model.provider).toBe('openai');
  });

  it('数据库不可用时抛错，不静默降级为另一套配置', async () => {
    const findMany = jest.fn().mockRejectedValue(new Error('db down'));
    const registry = new LlmModelRegistryService(
      { modelPreset: { findMany } } as never,
      crypto,
    );

    // 旧实现在此 catch 后返回 []，模型会静默换成 env 里的另一套配置
    await expect(registry.onModuleInit()).rejects.toThrow('db down');
  });

  it('没有任何预设时明确提示去后台配置', async () => {
    const { registry } = await createRegistry([]);

    expect(() => registry.resolveTextRequest()).toThrow('请先在后台配置模型');
  });

  it('没有显式默认模型时不回退到列表第一项', async () => {
    const { registry } = await createRegistry([row({ isDefault: false })]);

    expect(() => registry.resolveTextRequest()).toThrow('未匹配到任何模型预设');
  });

  it('按 modelId 精确匹配，未命中时报错而不是回退默认预设', async () => {
    const { registry } = await createRegistry([row()]);

    expect(() =>
      registry.resolveTextRequest({ model: { modelId: 'missing:model' } }),
    ).toThrow('未找到模型预设');
  });

  it('能力档位来自数据库，供 Flow 校验判断可否用于带工具节点', async () => {
    const { registry } = await createRegistry([
      row({ capability: ModelPresetCapability.BASIC }),
    ]);

    expect(registry.getCapability('openai:gpt-5.5')).toBe('basic');
    expect(registry.getCapability('missing')).toBeUndefined();
  });

  it('调用方显式覆盖生成参数时优先于预设默认值', async () => {
    const { registry } = await createRegistry([row({ temperature: 0.2 })]);

    const resolved = registry.resolveTextRequest({
      generation: { temperature: 0.9 },
    });

    expect(resolved.generation.temperature).toBe(0.9);
  });

  it('只加载启用的预设', async () => {
    const { findMany } = await createRegistry([row()]);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enabled: true, connection: { enabled: true } },
        include: { connection: true },
      }),
    );
  });
});
