import { BadRequestException } from '@nestjs/common';
import {
  ModelPresetCapability,
  ModelProviderConnectionStatus,
  ModelUpstreamFormat,
} from '@prisma/client';
import { LlmCredentialCryptoService } from '../llm/llm-credential-crypto.service';
import { ModelProviderConnectionService } from './model-provider-connection.service';

describe('ModelProviderConnectionService', () => {
  const encryptionKey = Buffer.alloc(32, 7).toString('base64');
  const crypto = new LlmCredentialCryptoService({
    get: () => encryptionKey,
  } as never);
  const model = {
    id: 'model-1',
    connectionId: 'connection-1',
    presetId: 'deepseek-aabb:deepseek-chat',
    name: 'DeepSeek Chat',
    description: '',
    model: 'deepseek-chat',
    upstreamFormat: ModelUpstreamFormat.OPENAI_CHAT_COMPLETIONS,
    temperature: null,
    maxOutputTokens: null,
    topP: null,
    enabled: true,
    isDefault: false,
    capability: ModelPresetCapability.TOOLS,
    lastCheckedAt: null,
    lastCheckError: null,
    createdAt: new Date('2026-09-04T00:00:00.000Z'),
    updatedAt: new Date('2026-09-04T00:00:00.000Z'),
  };
  const connection = {
    id: 'connection-1',
    connectionKey: 'deepseek-aabb',
    providerKey: 'deepseek',
    name: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com/v1',
    enabled: true,
    apiKeyCiphertext: crypto.encrypt('sk-deepseek'),
    apiKeyFingerprint: crypto.fingerprint('sk-deepseek'),
    status: ModelProviderConnectionStatus.REACHABLE,
    lastCheckedAt: null,
    lastCheckError: null,
    createdAt: new Date('2026-09-04T00:00:00.000Z'),
    updatedAt: new Date('2026-09-04T00:00:00.000Z'),
    models: [model],
  };
  const prisma = {
    modelProviderConnection: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    modelPreset: {
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const registry = { invalidate: jest.fn() };
  const probeService = { probeReachability: jest.fn() };
  const referenceService = { findByPresetIds: jest.fn() };
  const modelPresetService = { toResponse: jest.fn() };

  /**
   * 构造连接服务
   * @returns 返回使用内存替身依赖的连接服务
   * @description 数据写入仍经过真实服务分支，只有数据库和上游模型调用被替换。
   */
  function createService() {
    return new ModelProviderConnectionService(
      prisma as never,
      crypto,
      registry as never,
      probeService as never,
      referenceService as never,
      modelPresetService as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (operation: (transaction: typeof prisma) => Promise<unknown>) =>
        operation(prisma),
    );
    prisma.modelProviderConnection.findUnique.mockResolvedValue(connection);
    prisma.modelProviderConnection.create.mockResolvedValue({
      id: 'connection-1',
    });
    registry.invalidate.mockResolvedValue(undefined);
    referenceService.findByPresetIds.mockResolvedValue(
      new Map([
        [
          model.presetId,
          { agentCount: 0, flowCount: 0, taskCount: 0, items: [] },
        ],
      ]),
    );
    modelPresetService.toResponse.mockReturnValue({ id: model.id });
  });

  it('在同一事务创建连接和至少一个共享凭据的模型', async () => {
    await createService().create({
      providerKey: 'deepseek',
      name: 'DeepSeek 官方',
      baseURL: 'https://api.deepseek.com/v1/',
      apiKey: 'sk-new-secret',
      models: [
        {
          name: 'DeepSeek Chat',
          model: 'deepseek-chat',
          upstreamFormat: 'openai_chat_completions',
        },
      ],
    });

    const write = prisma.modelProviderConnection.create.mock.calls[0][0].data;
    expect(write.baseURL).toBe('https://api.deepseek.com/v1');
    expect(write.apiKeyCiphertext).not.toContain('sk-new-secret');
    expect(write.models.create[0]).toEqual(
      expect.objectContaining({
        presetId: expect.stringMatching(
          /^deepseek-[0-9a-f]{16}:deepseek-chat$/,
        ),
        model: 'deepseek-chat',
      }),
    );
    expect(registry.invalidate).toHaveBeenCalledTimes(1);
  });

  it('允许使用 Gemini 原生协议创建 Google 连接', async () => {
    await createService().create({
      providerKey: 'google',
      name: 'Google Gemini',
      baseURL: 'https://generativelanguage.googleapis.com',
      apiKey: 'google-secret',
      models: [
        {
          name: 'Gemini 2.5 Pro',
          model: 'gemini-2.5-pro',
          upstreamFormat: 'gemini_generate_content',
        },
      ],
    });

    const write = prisma.modelProviderConnection.create.mock.calls[0][0].data;
    expect(write.models.create[0]).toEqual(
      expect.objectContaining({
        upstreamFormat: ModelUpstreamFormat.GEMINI_GENERATE_CONTENT,
      }),
    );
  });

  it('连接 URL 变化时在同一事务重置连接和全部子模型', async () => {
    await createService().update('connection-1', {
      baseURL: 'https://gateway.example.com/v1/',
    });

    expect(prisma.modelProviderConnection.update).toHaveBeenCalledWith({
      where: { id: 'connection-1' },
      data: expect.objectContaining({
        baseURL: 'https://gateway.example.com/v1',
        status: ModelProviderConnectionStatus.UNVERIFIED,
        lastCheckedAt: null,
        lastCheckError: null,
      }),
    });
    expect(prisma.modelPreset.updateMany).toHaveBeenCalledWith({
      where: { connectionId: 'connection-1' },
      data: {
        capability: ModelPresetCapability.UNVERIFIED,
        lastCheckedAt: null,
        lastCheckError: null,
      },
    });
  });

  it('拒绝在初始模型中把停用模型设为系统默认', async () => {
    await expect(
      createService().create({
        providerKey: 'deepseek',
        name: 'DeepSeek 官方',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-new-secret',
        models: [
          {
            name: 'DeepSeek Chat',
            model: 'deepseek-chat',
            upstreamFormat: 'openai_chat_completions',
            enabled: false,
            isDefault: true,
          },
        ],
      }),
    ).rejects.toThrow('停用的模型不能设为系统默认模型');

    expect(prisma.modelProviderConnection.create).not.toHaveBeenCalled();
  });

  it('连接探测只更新连接状态，不改模型工具能力', async () => {
    probeService.probeReachability.mockResolvedValue({ reachable: true });

    await expect(
      createService().probe('connection-1', { modelPresetId: 'model-1' }),
    ).resolves.toEqual({
      status: 'reachable',
      reachable: true,
      error: null,
    });

    expect(prisma.modelProviderConnection.update).toHaveBeenCalledWith({
      where: { id: 'connection-1' },
      data: {
        status: ModelProviderConnectionStatus.REACHABLE,
        lastCheckedAt: expect.any(Date),
        lastCheckError: null,
      },
    });
    expect(prisma.modelPreset.updateMany).not.toHaveBeenCalled();
  });

  it('拒绝删除仍包含模型的连接', async () => {
    await expect(createService().remove('connection-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.modelProviderConnection.delete).not.toHaveBeenCalled();
  });
});
