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
import type { LlmVisionTransport } from '../llm/model-vision.catalog';

const ADMIN_IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};
const SHARED_IMAGE_MAX_SIZE = 10 * 1024 * 1024;
const AGENT_AVATAR_MAX_SIZE = 2 * 1024 * 1024;
export const CHAT_IMAGE_MAX_SIZE = 4 * 1024 * 1024;
const CHAT_IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export interface ResolvedChatImage {
  assetId: string;
  publicUrl: string;
  mimeType: string;
  size: number;
  wireDataUri?: string;
}

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
   * 校验当前用户可用于聊天识图的图片资产。
   * @param userId 当前聊天用户 ID
   * @param assetId 客户端提交的 StorageAsset ID
   * @returns 返回经数据库事实与 COS 真实元数据共同校验的图片投影
   * @description 只接受本人、ACTIVE、chat-image 的 JPEG/PNG/WebP，并通过 COS HEAD 验证
   * 实际类型和大小。任何失败都发生在聊天消息与任务落库之前。
   */
  async validateChatImageAsset(
    userId: string,
    assetId: string,
  ): Promise<ResolvedChatImage> {
    const asset = await this.loadChatImageAsset(userId, assetId);
    const metadata = await this.cosStorageService.getObjectMetadata(asset.key);
    this.assertChatImageMetadata(
      metadata.contentType,
      metadata.contentLength,
      asset.mimeType,
      asset.size,
    );
    return {
      assetId: asset.id,
      publicUrl: this.cosStorageService.resolveAccessUrl(asset.key),
      mimeType: metadata.contentType,
      size: metadata.contentLength,
    };
  }

  /**
   * 为 Activity Worker 构造模型视觉输入。
   * @param userId 当前任务用户 ID
   * @param assetId 任务载荷中锁定的图片资产 ID
   * @param transport 目标模型要求的图片传输方式
   * @returns 返回公网 URL；data_uri 模式额外返回只存在于 Worker 内存的 Data URI
   * @description GPT 直接消费公网 URL；K3 从 COS 下载一次。Base64 不写数据库、Redis、
   * Temporal Payload 或 LangGraph checkpoint，由模型请求发送层临时替换。
   */
  async prepareChatImageForModel(
    userId: string,
    assetId: string,
    transport: LlmVisionTransport,
  ): Promise<ResolvedChatImage> {
    if (transport === 'public_url') {
      return this.validateChatImageAsset(userId, assetId);
    }
    const asset = await this.loadChatImageAsset(userId, assetId);
    const downloaded = await this.cosStorageService.downloadObject(
      asset.key,
      CHAT_IMAGE_MAX_SIZE,
    );
    this.assertChatImageMetadata(
      downloaded.contentType,
      downloaded.contentLength,
      asset.mimeType,
      asset.size,
    );
    return {
      assetId: asset.id,
      publicUrl: this.cosStorageService.resolveAccessUrl(asset.key),
      mimeType: downloaded.contentType,
      size: downloaded.contentLength,
      wireDataUri: `data:${downloaded.contentType};base64,${downloaded.body.toString('base64')}`,
    };
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

  /** 读取并校验聊天图片的数据库归属与状态事实。 */
  private async loadChatImageAsset(userId: string, assetId: string) {
    const asset = await this.prisma.storageAsset.findFirst({
      where: {
        id: assetId,
        uploadedById: userId,
        kind: StorageAssetKind.IMAGE,
        usage: 'chat-image',
        status: StorageAssetStatus.ACTIVE,
      },
    });
    if (!asset) {
      throw new BadRequestException('图片资产不存在、不可用或不属于当前用户');
    }
    return asset;
  }

  /** 校验 COS 真实元数据，并拒绝登记信息与真实对象不一致。 */
  private assertChatImageMetadata(
    actualMimeType: string,
    actualSize: number,
    declaredMimeType: string | null,
    declaredSize: number | null,
  ): void {
    if (!CHAT_IMAGE_CONTENT_TYPES.has(actualMimeType)) {
      throw new BadRequestException('聊天图片仅支持 JPEG、PNG 或 WebP');
    }
    if (actualSize > CHAT_IMAGE_MAX_SIZE) {
      throw new BadRequestException('聊天图片不能超过 4MB');
    }
    if (declaredMimeType && declaredMimeType.toLowerCase() !== actualMimeType) {
      throw new BadRequestException('图片登记 MIME 与 COS 实际对象不一致');
    }
    if (declaredSize !== null && declaredSize !== actualSize) {
      throw new BadRequestException('图片登记大小与 COS 实际对象不一致');
    }
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
