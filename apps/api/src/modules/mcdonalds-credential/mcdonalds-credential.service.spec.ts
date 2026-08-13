import { McDonaldsCredentialService } from './mcdonalds-credential.service';

describe('McDonaldsCredentialService', () => {
  const createPrismaMock = () => ({
    mcDonaldsCredential: {
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    mcpConnectionAudit: {
      create: jest.fn(),
    },
    $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
      callback({
        mcDonaldsCredential: {
          findFirst: jest.fn(),
          updateMany: jest.fn(),
          create: jest.fn(),
        },
      }),
    ),
  });

  const createCryptoMock = () => ({
    encrypt: jest.fn().mockReturnValue('ciphertext'),
    fingerprint: jest.fn().mockReturnValue('fingerprint'),
    toDisplayHint: jest.fn().mockReturnValue('Token ...print'),
  });

  it('绑定前验证 Token，并撤销同一用户此前活跃凭据', async () => {
    const prisma = createPrismaMock();
    const transaction = {
      mcDonaldsCredential: {
        findFirst: jest.fn().mockResolvedValue({ id: 'old-credential' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({
          id: 'new-credential',
          status: 'ACTIVE',
          tokenFingerprint: 'fingerprint',
          verifiedAt: new Date('2026-08-13T12:00:00.000Z'),
          updatedAt: new Date('2026-08-13T12:00:00.000Z'),
        }),
      },
    };
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof transaction) => unknown) => callback(transaction),
    );
    const manager = {
      verifyMcDonaldsToken: jest.fn().mockResolvedValue(undefined),
      evictCredentialClients: jest.fn().mockResolvedValue(undefined),
    };
    const crypto = createCryptoMock();
    const service = new McDonaldsCredentialService(
      prisma as never,
      crypto as never,
      manager as never,
    );

    const result = await service.bind('user-1', '  token-secret  ');

    expect(manager.verifyMcDonaldsToken).toHaveBeenCalledWith('token-secret');
    expect(crypto.encrypt).toHaveBeenCalledWith('token-secret');
    expect(transaction.mcDonaldsCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', status: 'ACTIVE' },
      }),
    );
    expect(transaction.mcDonaldsCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          tokenCiphertext: 'ciphertext',
          tokenFingerprint: 'fingerprint',
          status: 'ACTIVE',
        }),
      }),
    );
    expect(manager.evictCredentialClients).toHaveBeenCalledWith([
      'old-credential',
    ]);
    expect(prisma.mcpConnectionAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        credentialId: 'new-credential',
        mcpServer: 'mcdonalds',
        operation: 'CREDENTIAL_BIND_VERIFICATION',
        mcpTool: 'tools/list',
        status: 'SUCCESS',
        errorMessage: null,
      }),
    });
    expect(prisma.mcpConnectionAudit.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          token: expect.anything(),
          tokenCiphertext: expect.anything(),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ id: 'new-credential', hint: 'Token ...print' }),
    );
  });

  it('绑定校验失败时记录脱敏失败审计，不创建凭据', async () => {
    const prisma = createPrismaMock();
    const manager = {
      verifyMcDonaldsToken: jest
        .fn()
        .mockRejectedValue(new Error('401 invalid token: token-secret')),
      evictCredentialClients: jest.fn(),
    };
    const service = new McDonaldsCredentialService(
      prisma as never,
      createCryptoMock() as never,
      manager as never,
    );

    await expect(service.bind('user-1', 'token-secret')).rejects.toThrow(
      '麦当劳 MCP Token 无效或暂时无法验证，请确认后重试',
    );

    expect(prisma.mcpConnectionAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        credentialId: null,
        mcpServer: 'mcdonalds',
        operation: 'CREDENTIAL_BIND_VERIFICATION',
        mcpTool: 'tools/list',
        status: 'ERROR',
        errorMessage: '认证或工具清单校验失败',
      }),
    });
    expect(prisma.mcDonaldsCredential.create).not.toHaveBeenCalled();
  });

  it('解绑只撤销当前活跃凭据，并清理对应 MCP client', async () => {
    const prisma = createPrismaMock();
    prisma.mcDonaldsCredential.findFirst.mockResolvedValue({
      id: 'credential-1',
    });
    const manager = {
      verifyMcDonaldsToken: jest.fn(),
      evictCredentialClients: jest.fn().mockResolvedValue(undefined),
    };
    const service = new McDonaldsCredentialService(
      prisma as never,
      createCryptoMock() as never,
      manager as never,
    );

    await service.unbind('user-1');

    expect(prisma.mcDonaldsCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'credential-1' },
        data: expect.objectContaining({ status: 'REVOKED' }),
      }),
    );
    expect(manager.evictCredentialClients).toHaveBeenCalledWith([
      'credential-1',
    ]);
  });
});
