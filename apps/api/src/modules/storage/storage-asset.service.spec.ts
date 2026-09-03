import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
        count: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn((operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
    };
    const cos = {
      createUploadCredential: jest.fn(),
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
    originalName: 'avatar.png',
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
    expect(dto).not.toHaveProperty('originalName');
  });

  it('登记他人路径下的 key 被拒绝', async () => {
    const { service } = createService();
    await expect(
      service.register('user-2', { key: assetRow.key }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('通用图片在 10MB 内可以签发后台上传凭证', async () => {
    const { service, cos } = createService();
    const credential = { key: assetRow.key };
    cos.createUploadCredential.mockResolvedValue(credential);

    await expect(
      service.createAdminImageUploadCredential('user-1', {
        ext: 'webp',
        usage: 'shared-image',
        size: 10 * 1024 * 1024,
      }),
    ).resolves.toEqual(credential);
    expect(cos.createUploadCredential).toHaveBeenCalledWith(
      'user-1',
      'image',
      'webp',
    );
  });

  it('头像超过 2MB 时拒绝签发凭证', async () => {
    const { service, cos } = createService();

    await expect(
      service.createAdminImageUploadCredential('user-1', {
        ext: 'png',
        usage: 'agent-avatar',
        size: 2 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(cos.createUploadCredential).not.toHaveBeenCalled();
  });

  it('登记阶段再次拒绝超过 2MB 的头像', async () => {
    const { service, prisma } = createService();

    await expect(
      service.registerAdminImage('user-1', {
        key: assetRow.key,
        usage: 'agent-avatar',
        size: 2 * 1024 * 1024 + 1,
        mimeType: 'image/png',
        originalName: 'avatar.png',
      }),
    ).rejects.toThrow('智能体头像不能超过 2MB');
    expect(prisma.storageAsset.upsert).not.toHaveBeenCalled();
  });

  it('登记阶段拒绝 key 扩展名与 MIME 不一致', async () => {
    const { service, prisma } = createService();

    await expect(
      service.registerAdminImage('user-1', {
        key: assetRow.key,
        usage: 'agent-avatar',
        size: 1024,
        mimeType: 'image/jpeg',
        originalName: 'avatar.png',
      }),
    ).rejects.toThrow('图片扩展名与 MIME 类型不一致');
    expect(prisma.storageAsset.upsert).not.toHaveBeenCalled();
  });

  it('后台图片登记返回原文件名', async () => {
    const { service, prisma } = createService();
    prisma.storageAsset.upsert.mockResolvedValue(assetRow);

    await expect(
      service.registerAdminImage('user-1', {
        key: assetRow.key,
        usage: 'agent-avatar',
        size: 1024,
        mimeType: 'image/png',
        originalName: 'avatar.png',
      }),
    ).resolves.toMatchObject({ originalName: 'avatar.png' });
  });

  it('后台图片凭证拒绝 HEIC 等未开放格式', async () => {
    const { service, cos } = createService();

    await expect(
      service.createAdminImageUploadCredential('user-1', {
        ext: 'heic',
        usage: 'shared-image',
        size: 1024,
      }),
    ).rejects.toThrow('仅支持 JPG、PNG、WebP 和 GIF 图片');
    expect(cos.createUploadCredential).not.toHaveBeenCalled();
  });

  it('按图片类型、搜索、用途与状态分页查询资源', async () => {
    const { service, prisma } = createService();
    prisma.storageAsset.findMany.mockResolvedValue([assetRow]);
    prisma.storageAsset.count.mockResolvedValue(25);

    const page = await service.listAdminImages({
      page: 2,
      pageSize: 24,
      search: 'avatar',
      usage: 'agent-avatar',
      status: StorageAssetStatus.ACTIVE,
    });

    const where = {
      kind: StorageAssetKind.IMAGE,
      usage: 'agent-avatar',
      status: StorageAssetStatus.ACTIVE,
      OR: [
        {
          originalName: {
            contains: 'avatar',
            mode: 'insensitive',
          },
        },
        { key: { contains: 'avatar', mode: 'insensitive' } },
      ],
    };
    expect(prisma.storageAsset.findMany).toHaveBeenCalledWith({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 24,
      take: 24,
    });
    expect(prisma.storageAsset.count).toHaveBeenCalledWith({ where });
    expect(page).toMatchObject({
      items: [expect.objectContaining({ originalName: 'avatar.png' })],
      page: 2,
      pageSize: 24,
      total: 25,
      totalPages: 2,
    });
  });

  it('软删除和恢复只更新登记状态', async () => {
    const { service, prisma } = createService();
    prisma.storageAsset.findUnique.mockResolvedValue(assetRow);
    prisma.storageAsset.update.mockResolvedValue({
      ...assetRow,
      status: StorageAssetStatus.DELETED,
    });

    await expect(
      service.updateAdminImageStatus(assetRow.id, StorageAssetStatus.DELETED),
    ).resolves.toMatchObject({ status: StorageAssetStatus.DELETED });
    expect(prisma.storageAsset.update).toHaveBeenCalledWith({
      where: { id: assetRow.id },
      data: { status: StorageAssetStatus.DELETED },
    });
  });

  it('图片资源状态接口拒绝修改音频资产', async () => {
    const { service, prisma } = createService();
    prisma.storageAsset.findUnique.mockResolvedValue({
      ...assetRow,
      kind: StorageAssetKind.AUDIO,
    });

    await expect(
      service.updateAdminImageStatus(assetRow.id, StorageAssetStatus.DELETED),
    ).rejects.toThrow('图片资源接口不能修改音频资产');
    expect(prisma.storageAsset.update).not.toHaveBeenCalled();
  });
});
