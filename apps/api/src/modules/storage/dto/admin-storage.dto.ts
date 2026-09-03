import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StorageAssetKind, StorageAssetStatus } from '@prisma/client';
import { CosUploadCredentialResponseDto } from './cos-upload-credential.dto';

export const ADMIN_IMAGE_UPLOAD_USAGES = [
  'shared-image',
  'agent-avatar',
] as const;
export type AdminImageUploadUsage = (typeof ADMIN_IMAGE_UPLOAD_USAGES)[number];

export const ADMIN_IMAGE_LIST_USAGES = [
  ...ADMIN_IMAGE_UPLOAD_USAGES,
  'chat-image',
  'ai-image',
] as const;
export type AdminImageListUsage = (typeof ADMIN_IMAGE_LIST_USAGES)[number];

export const ADMIN_IMAGE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
] as const;

export const ADMIN_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

/** Admin 图片上传凭证请求。 */
export class AdminImageUploadCredentialDto {
  @ApiProperty({ enum: ADMIN_IMAGE_EXTENSIONS })
  @IsIn(ADMIN_IMAGE_EXTENSIONS)
  ext: string;

  @ApiProperty({ enum: ADMIN_IMAGE_UPLOAD_USAGES })
  @IsIn(ADMIN_IMAGE_UPLOAD_USAGES)
  usage: AdminImageUploadUsage;

  @ApiProperty({ description: '浏览器声明的文件字节数', maximum: 10485760 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  size: number;
}

/** Admin 上传成功后的图片资产登记请求。 */
export class AdminRegisterImageAssetDto {
  @ApiProperty({ description: '上传凭证返回的图片对象 key' })
  @IsString()
  @MaxLength(255)
  @Matches(/^image\/\d{6}\/[^/]+\/[0-9a-f]{32}\.[a-z0-9]{1,8}$/, {
    message: '图片对象 key 格式不合法',
  })
  key: string;

  @ApiProperty({ enum: ADMIN_IMAGE_UPLOAD_USAGES })
  @IsIn(ADMIN_IMAGE_UPLOAD_USAGES)
  usage: AdminImageUploadUsage;

  @ApiProperty({ description: '文件字节数', maximum: 10485760 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  size: number;

  @ApiProperty({ enum: ADMIN_IMAGE_MIME_TYPES })
  @IsIn(ADMIN_IMAGE_MIME_TYPES)
  mimeType: string;

  @ApiProperty({ description: '原文件名，仅用于展示、搜索和下载命名' })
  @IsString()
  @MaxLength(255)
  originalName: string;
}

/** Admin 图片资源分页查询。 */
export class AdminStorageAssetListQueryDto {
  @ApiPropertyOptional({ type: Number, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ type: Number, default: 24, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 24;

  @ApiPropertyOptional({ description: '匹配原文件名或对象 key' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: ADMIN_IMAGE_LIST_USAGES })
  @IsOptional()
  @IsIn(ADMIN_IMAGE_LIST_USAGES)
  usage?: AdminImageListUsage;

  @ApiPropertyOptional({ enum: StorageAssetStatus })
  @IsOptional()
  @IsIn(Object.values(StorageAssetStatus))
  status?: StorageAssetStatus;
}

/** Admin 图片资源状态更新请求。 */
export class AdminUpdateStorageAssetStatusDto {
  @ApiProperty({
    enum: [StorageAssetStatus.ACTIVE, StorageAssetStatus.DELETED],
  })
  @IsIn([StorageAssetStatus.ACTIVE, StorageAssetStatus.DELETED])
  status: Extract<StorageAssetStatus, 'ACTIVE' | 'DELETED'>;
}

/** Admin 图片资源详情投影。 */
export class AdminStorageAssetDto {
  @ApiProperty() id: string;
  @ApiProperty() key: string;
  @ApiProperty() url: string;
  @ApiProperty({ enum: StorageAssetKind }) kind: StorageAssetKind;
  @ApiProperty() usage: string;
  @ApiProperty({ nullable: true }) originalName: string | null;
  @ApiProperty({ nullable: true }) mimeType: string | null;
  @ApiProperty({ nullable: true }) size: number | null;
  @ApiProperty({ enum: StorageAssetStatus }) status: StorageAssetStatus;
  @ApiProperty({ example: 1735689600000 }) createdAt: number;
}

/** Admin 图片资源分页响应。 */
export class AdminStorageAssetPageDto {
  @ApiProperty({ type: AdminStorageAssetDto, isArray: true })
  items: AdminStorageAssetDto[];
  @ApiProperty() page: number;
  @ApiProperty() pageSize: number;
  @ApiProperty() total: number;
  @ApiProperty() totalPages: number;
}

/** Admin 图片上传凭证响应；与 COS 单对象凭证字段一致。 */
export class AdminImageUploadCredentialResponseDto extends CosUploadCredentialResponseDto {}
