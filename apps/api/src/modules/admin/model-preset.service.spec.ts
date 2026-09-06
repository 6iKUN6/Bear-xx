import { BadRequestException } from '@nestjs/common';
import {
  ModelPresetCapability,
  ModelProviderConnectionStatus,
  ModelUpstreamFormat,
} from '@prisma/client';
import { LlmCredentialCryptoService } from '../llm/llm-credential-crypto.service';
import { ModelPresetService } from './model-preset.service';

describe('ModelPresetService', () => {
  const encryptionKey = Buffer.alloc(32, 11).toString('base64');
  const crypto = new LlmCredentialCryptoService({
    get: () => encryptionKey,
  } as never);
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
  };
  const model = {
    id: 'model-1',
    connectionId: connection.id,
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
    connection,
  };
  const prisma = {
    modelProviderConnection: { findUnique: jest.fn() },
    modelPreset: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const registry = { invalidate: jest.fn() };
  const probeService = { probe: jest.fn() };
  const referenceService = { findByPresetId: jest.fn() };

  /**
   * 构造模型预设服务
   * @returns 返回使用数据库和探针替身的服务实例
   * @description 凭据加解密使用真实实现，验证共享连接密钥能进入探针但不进入 DTO。
   */
  function createService() {
    return new ModelPresetService(
      prisma as never,
      crypto,
      registry as never,
      probeService as never,
      referenceService as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (operation: (transaction: typeof prisma) => Promise<unknown>) =>
        operation(prisma),
    );
    prisma.modelProviderConnection.findUnique.mockResolvedValue(connection);
    prisma.modelPreset.findUnique.mockResolvedValue(model);
    prisma.modelPreset.create.mockResolvedValue(model);
    prisma.modelPreset.update.mockResolvedValue(model);
    registry.invalidate.mockResolvedValue(undefined);
    referenceService.findByPresetId.mockResolvedValue({
      agentCount: 0,
      flowCount: 0,
      taskCount: 0,
      items: [],
    });
  });

  it('使用不可变连接键自动生成 presetId', async () => {
    await createService().create('connection-1', {
      name: 'DeepSeek Reasoner',
      model: 'deepseek-reasoner',
      upstreamFormat: 'openai_chat_completions',
    });

    expect(prisma.modelPreset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          connectionId: 'connection-1',
          presetId: 'deepseek-aabb:deepseek-reasoner',
          model: 'deepseek-reasoner',
        }),
      }),
    );
  });

  it('允许在 Google 连接下创建 Gemini 原生协议模型', async () => {
    prisma.modelProviderConnection.findUnique.mockResolvedValue({
      ...connection,
      providerKey: 'google',
    });

    await createService().create('connection-1', {
      name: 'Gemini 2.5 Pro',
      model: 'gemini-2.5-pro',
      upstreamFormat: 'gemini_generate_content',
    });

    expect(prisma.modelPreset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          upstreamFormat: ModelUpstreamFormat.GEMINI_GENERATE_CONTENT,
        }),
      }),
    );
  });

  it('修改模型 ID 时保持 presetId 不变并只重置当前模型', async () => {
    await createService().update('model-1', { model: 'deepseek-chat-v2' });

    const write = prisma.modelPreset.update.mock.calls[0][0];
    expect(write.where).toEqual({ id: 'model-1' });
    expect(write.data).not.toHaveProperty('presetId');
    expect(write.data).not.toHaveProperty('connectionId');
    expect(write.data).toEqual(
      expect.objectContaining({
        model: 'deepseek-chat-v2',
        capability: ModelPresetCapability.UNVERIFIED,
        lastCheckedAt: null,
        lastCheckError: null,
      }),
    );
  });

  it('拒绝把停用模型设为系统默认', async () => {
    await expect(
      createService().create('connection-1', {
        name: 'DeepSeek Reasoner',
        model: 'deepseek-reasoner',
        upstreamFormat: 'openai_chat_completions',
        enabled: false,
        isDefault: true,
      }),
    ).rejects.toThrow('停用的模型或连接不能设为系统默认模型');

    expect(prisma.modelPreset.create).not.toHaveBeenCalled();
  });

  it('模型探测使用所属连接的 URL 与解密密钥', async () => {
    probeService.probe.mockResolvedValue({
      capability: 'tools',
      stages: { reachable: true, toolRoundTrip: true },
    });

    await createService().probeExisting('model-1');

    expect(probeService.probe).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: model.presetId,
        platform: 'deepseek',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-deepseek',
      }),
    );
  });

  it('存在 Agent 或 Flow 引用时拒绝删除并返回护栏错误', async () => {
    referenceService.findByPresetId.mockResolvedValue({
      agentCount: 1,
      flowCount: 0,
      taskCount: 0,
      items: [
        {
          type: 'agent',
          id: 'agent-1',
          name: '客服',
          versionId: null,
          version: null,
          status: null,
        },
      ],
    });

    await expect(createService().remove('model-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.modelPreset.delete).not.toHaveBeenCalled();
  });
});
