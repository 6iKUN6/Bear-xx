import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  StorageAssetKind,
  StorageAssetStatus,
  type StorageAsset,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CosStorageService } from './cos-storage.service';
import type {
  RegisterAssetDto,
  StorageAssetDto,
} from './dto/storage-asset.dto';
import type {
  AdminImageUploadCredentialDto,
  AdminRegisterImageAssetDto,
  AdminStorageAssetDto,
  AdminStorageAssetListQueryDto,
  AdminStorageAssetPageDto,
} from './dto/admin-storage.dto';

const ADMIN_IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};
const SHARED_IMAGE_MAX_SIZE = 10 * 1024 * 1024;
const AGENT_AVATAR_MAX_SIZE = 2 * 1024 * 1024;

/** 资产登记服务内部使用的完整输入；Admin 可额外保存原文件名。 */
export interface RegisterStorageAssetInput extends RegisterAssetDto {
  originalName?: string;
}

/**
 * 存储资产登记簿
 * @description 直传成功后登记 key，供复用选择器检索与失效治理。
 * key 是唯一事实源；访问 URL 每次读取时由 CosStorageService 统一拼接。
 */
@Injectable()
export class StorageAssetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cosStorageService: CosStorageService,
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
    const asset = await this.registerAssetRecord(userId, dto);
    return this.toStorageDto(asset);
  }

  /**
   * 幂等写入资产登记记录
   * @param userId 当前上传用户ID
   * @param dto 对象 key 与待补全元数据
   * @returns 返回写入后的 Prisma 资产记录
   * @description 通用登记和 Admin 图片登记共用同一归属校验及 upsert 规则，避免两条写入路径漂移。
   */
  private async registerAssetRecord(
    userId: string,
    dto: RegisterStorageAssetInput,
  ): Promise<StorageAsset> {
    const keyUserId = dto.key.split('/')[2];
    if (keyUserId !== userId) {
      throw new ForbiddenException('只能登记本人上传的对象');
    }

    const kind = dto.key.startsWith('audio/')
      ? StorageAssetKind.AUDIO
      : StorageAssetKind.IMAGE;

    return this.prisma.storageAsset.upsert({
      where: { key: dto.key },
      create: {
        key: dto.key,
        kind,
        usage: dto.usage ?? '',
        originalName: dto.originalName ?? null,
        mimeType: dto.mimeType ?? null,
        size: dto.size ?? null,
        uploadedById: userId,
      },
      update: {
        // 重复登记视为补全元数据；不允许改 kind/归属
        usage: dto.usage ?? undefined,
        originalName: dto.originalName ?? undefined,
        mimeType: dto.mimeType ?? undefined,
        size: dto.size ?? undefined,
      },
    });
  }

  /**
   * 为 Admin 图片直传签发凭证
   * @param userId 当前管理员用户ID
   * @param dto 图片用途、扩展名与声明大小
   * @returns 返回单对象 COS PUT 凭证
   * @description 后台只开放常用图片格式，并按用途执行 10MB/2MB 上限；通过后复用 COS 单对象签名能力。
   */
  async createAdminImageUploadCredential(
    userId: string,
    dto: AdminImageUploadCredentialDto,
  ) {
    const ext = dto.ext.toLowerCase();
    this.assertAdminImagePolicy(dto.usage, dto.size, ext);

    return this.cosStorageService.createUploadCredential(userId, 'image', ext);
  }

  /**
   * 登记 Admin 直传成功的图片
   * @param userId 当前管理员用户ID
   * @param dto 图片 key、用途、大小、MIME 与原文件名
   * @returns 返回已登记图片投影
   * @description 登记阶段再次执行用途大小和格式校验，防止用通用图片凭证上传后改登记为超限头像。
   */
  async registerAdminImage(
    userId: string,
    dto: AdminRegisterImageAssetDto,
  ): Promise<AdminStorageAssetDto> {
    const ext = dto.key.split('.').at(-1)?.toLowerCase() ?? '';
    const expectedMimeType = this.assertAdminImagePolicy(
      dto.usage,
      dto.size,
      ext,
    );
    if (dto.mimeType !== expectedMimeType) {
      throw new BadRequestException('图片扩展名与 MIME 类型不一致');
    }
    const asset = await this.registerAssetRecord(userId, dto);
    return this.toAdminDto(asset);
  }

  /**
   * 分页查询 Admin 图片资源库
   * @param query 页码、搜索词、用途与状态过滤
   * @returns 返回图片资产分页结果
   * @description 固定过滤 IMAGE，搜索同时匹配原文件名与对象 key；总数与当前页在同一 Prisma 事务中读取。
   */
  async listAdminImages(
    query: AdminStorageAssetListQueryDto,
  ): Promise<AdminStorageAssetPageDto> {
    const search = query.search?.trim();
    const where: Prisma.StorageAssetWhereInput = {
      kind: StorageAssetKind.IMAGE,
      usage: query.usage,
      status: query.status,
      ...(search
        ? {
            OR: [
              { originalName: { contains: search, mode: 'insensitive' } },
              { key: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [assets, total] = await this.prisma.$transaction([
      this.prisma.storageAsset.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.storageAsset.count({ where }),
    ]);

    return {
      items: assets.map((asset) => this.toAdminDto(asset)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  /**
   * 软删除或恢复 Admin 图片资源
   * @param id 图片资产ID
   * @param status 目标 ACTIVE 或 DELETED 状态
   * @returns 返回更新后的 Admin 图片投影
   * @description 只允许治理 IMAGE 资产，防止绕过图片资源页面修改音频登记状态。
   */
  async updateAdminImageStatus(
    id: string,
    status: Extract<StorageAssetStatus, 'ACTIVE' | 'DELETED'>,
  ): Promise<AdminStorageAssetDto> {
    const existing = await this.prisma.storageAsset.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('资产不存在');
    }
    if (existing.kind !== StorageAssetKind.IMAGE) {
      throw new BadRequestException('图片资源接口不能修改音频资产');
    }
    const asset = await this.prisma.storageAsset.update({
      where: { id },
      data: { status },
    });
    return this.toAdminDto(asset);
  }

  /**
   * 将数据库资产转换为终端公共投影
   * @param asset Prisma 资产记录
   * @returns 返回不含 Admin 展示字段的公共资产 DTO
   * @description URL 始终由当前 COS/CDN 域名与 key 生成，切换域名时无需刷新历史记录。
   */
  private toStorageDto(asset: StorageAsset): StorageAssetDto {
    return {
      id: asset.id,
      key: asset.key,
      url: this.cosStorageService.resolveAccessUrl(asset.key),
      kind: asset.kind,
      usage: asset.usage,
      mimeType: asset.mimeType,
      size: asset.size,
      status: asset.status,
      createdAt: asset.createdAt.getTime(),
    };
  }

  /**
   * 将数据库图片转换为 Admin 资源投影
   * @param asset Prisma 图片资产记录
   * @returns 返回带原文件名和运行时访问 URL 的管理 DTO
   * @description 原文件名只在 Admin 契约中暴露；历史资产保持 null，由前端回退展示 key 末段。
   */
  private toAdminDto(asset: StorageAsset): AdminStorageAssetDto {
    return {
      ...this.toStorageDto(asset),
      originalName: asset.originalName,
    };
  }

  /**
   * 校验 Admin 人工上传图片策略
   * @param usage 人工上传用途
   * @param size 声明文件字节数
   * @param ext 小写文件扩展名
   * @returns 返回该扩展名唯一对应的 MIME 类型
   * @description 该规则同时服务凭证签发和资产登记，避免两个阶段对格式或大小的判断漂移。
   */
  private assertAdminImagePolicy(
    usage: 'shared-image' | 'agent-avatar',
    size: number,
    ext: string,
  ): string {
    const mimeType = ADMIN_IMAGE_CONTENT_TYPES[ext];
    if (!mimeType) {
      throw new BadRequestException('仅支持 JPG、PNG、WebP 和 GIF 图片');
    }

    const maxSize =
      usage === 'agent-avatar' ? AGENT_AVATAR_MAX_SIZE : SHARED_IMAGE_MAX_SIZE;
    if (size > maxSize) {
      throw new BadRequestException(
        usage === 'agent-avatar'
          ? '智能体头像不能超过 2MB'
          : '通用图片不能超过 10MB',
      );
    }
    return mimeType;
  }
}
