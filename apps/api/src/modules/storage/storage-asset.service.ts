import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  StorageAssetKind,
  StorageAssetStatus,
  type StorageAsset,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QiniuStorageService } from './qiniu-storage.service';
import type {
  ListAssetsQueryDto,
  RegisterAssetDto,
  StorageAssetDto,
} from './dto/storage-asset.dto';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * 存储资产登记簿
 * @description 直传成功后登记 key，供复用选择器检索与失效治理。
 * key 是唯一事实源；访问 URL 每次读取时由 QiniuStorageService 现拼/现签。
 */
@Injectable()
export class StorageAssetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qiniuStorageService: QiniuStorageService,
  ) {}

  /**
   * 登记直传成功的资产
   * @description 幂等：同 key 重复登记返回既有记录（并可补全 usage/元数据）。
   * key 路径中的 userId 段必须与当前用户一致，防止登记他人对象或伪造 key。
   */
  async register(
    userId: string,
    dto: RegisterAssetDto,
  ): Promise<StorageAssetDto> {
    const keyUserId = dto.key.split('/')[2];
    if (keyUserId !== userId) {
      throw new ForbiddenException('只能登记本人上传的对象');
    }

    const kind = dto.key.startsWith('audio/')
      ? StorageAssetKind.AUDIO
      : StorageAssetKind.IMAGE;

    const asset = await this.prisma.storageAsset.upsert({
      where: { key: dto.key },
      create: {
        key: dto.key,
        kind,
        usage: dto.usage ?? '',
        mimeType: dto.mimeType ?? null,
        size: dto.size ?? null,
        uploadedById: userId,
      },
      update: {
        // 重复登记视为补全元数据；不允许改 kind/归属
        usage: dto.usage ?? undefined,
        mimeType: dto.mimeType ?? undefined,
        size: dto.size ?? undefined,
      },
    });

    return this.toDto(asset);
  }

  /** 资产列表（复用选择器）：默认只列 ACTIVE，按创建时间倒序 */
  async list(query: ListAssetsQueryDto): Promise<StorageAssetDto[]> {
    const assets = await this.prisma.storageAsset.findMany({
      where: {
        usage: query.usage ?? undefined,
        status: query.status ?? StorageAssetStatus.ACTIVE,
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    });
    return assets.map((asset) => this.toDto(asset));
  }

  /** 更新资产状态（BROKEN/DELETED/恢复 ACTIVE） */
  async updateStatus(
    id: string,
    status: StorageAssetStatus,
  ): Promise<StorageAssetDto> {
    const existing = await this.prisma.storageAsset.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('资产不存在');
    }
    const asset = await this.prisma.storageAsset.update({
      where: { id },
      data: { status },
    });
    return this.toDto(asset);
  }

  private toDto(asset: StorageAsset): StorageAssetDto {
    return {
      id: asset.id,
      key: asset.key,
      url: this.qiniuStorageService.resolveAccessUrl(asset.key),
      kind: asset.kind,
      usage: asset.usage,
      mimeType: asset.mimeType,
      size: asset.size,
      status: asset.status,
      createdAt: asset.createdAt.getTime(),
    };
  }
}
