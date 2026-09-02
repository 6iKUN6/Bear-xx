import { ForbiddenException } from '@nestjs/common';
import { StorageAssetKind, StorageAssetStatus } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CosStorageService } from './cos-storage.service';
import { StorageAssetService } from './storage-asset.service';

describe('StorageAssetService', () => {
  /**
   * 创建资产登记服务测试实例
   * @returns 返回服务与 prisma、COS 服务 mock
   * @description 验证登记归属校验、kind 推断与列表过滤，URL 拼装交给 COS 服务 mock。
   */
  const createService = () => {
    const prisma = {
      storageAsset: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const cos = {
      resolveAccessUrl: jest.fn(
        (key: string) => `https://cdn.example.com/${key}`,
      ),
    };
    return {
      service: new StorageAssetService(
        prisma as unknown as PrismaService,
        cos as unknown as CosStorageService,
      ),
      prisma,
      cos,
    };
  };

  const assetRow = {
    id: 'asset-1',
    key: 'image/202608/user-1/0123456789abcdef0123456789abcdef.png',
    kind: StorageAssetKind.IMAGE,
    usage: 'agent-avatar',
    mimeType: 'image/png',
    size: 1024,
    status: StorageAssetStatus.ACTIVE,
    uploadedById: 'user-1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  };

  it('登记本人 key：按前缀推断 kind 并返回拼好的访问 URL', async () => {
    const { service, prisma } = createService();
    prisma.storageAsset.upsert.mockResolvedValue(assetRow);

    const dto = await service.register('user-1', {
      key: assetRow.key,
      usage: 'agent-avatar',
      size: 1024,
      mimeType: 'image/png',
    });

    expect(prisma.storageAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: assetRow.key },
        create: expect.objectContaining({
          kind: StorageAssetKind.IMAGE,
          uploadedById: 'user-1',
        }) as unknown,
      }),
    );
    expect(dto.url).toBe(`https://cdn.example.com/${assetRow.key}`);
  });

  it('登记他人路径下的 key 被拒绝', async () => {
    const { service } = createService();
    await expect(
      service.register('user-2', { key: assetRow.key }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('列表默认只查 ACTIVE 并按创建时间倒序', async () => {
    const { service, prisma } = createService();
    prisma.storageAsset.findMany.mockResolvedValue([assetRow]);

    const list = await service.list({ usage: 'agent-avatar' });

    expect(prisma.storageAsset.findMany).toHaveBeenCalledWith({
      where: { usage: 'agent-avatar', status: StorageAssetStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe(StorageAssetStatus.ACTIVE);
  });
});
