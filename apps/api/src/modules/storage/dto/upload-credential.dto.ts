import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const UPLOAD_MEDIA_TYPES = ['image', 'audio'] as const;
export type UploadMediaType = (typeof UPLOAD_MEDIA_TYPES)[number];

/** 业务用途闭集：决定上传约束（如头像 2MB）与复用选择器的过滤维度 */
export const STORAGE_USAGES = [
  'agent-avatar',
  'chat-image',
  'voice-input',
] as const;
export type StorageUsage = (typeof STORAGE_USAGES)[number];

export class UploadCredentialDto {
  @ApiProperty({
    description: '上传媒体类型（决定存储目录、大小与 MIME 限制）',
    enum: UPLOAD_MEDIA_TYPES,
    example: 'image',
  })
  @IsIn(UPLOAD_MEDIA_TYPES)
  type: UploadMediaType;

  @ApiProperty({
    description: '文件扩展名（不含点），仅字母数字',
    example: 'png',
  })
  @IsString()
  @Matches(/^[a-z0-9]{1,8}$/i, { message: '扩展名仅支持 1-8 位字母数字' })
  ext: string;

  @ApiPropertyOptional({
    description: '业务用途；agent-avatar 会收紧大小限制到 2MB',
    enum: STORAGE_USAGES,
  })
  @IsOptional()
  @IsIn(STORAGE_USAGES)
  usage?: StorageUsage;
}

export class UploadCredentialResponseDto {
  @ApiProperty({ description: '七牛直传凭证（uploadFile 表单的 token 字段）' })
  token: string;

  @ApiProperty({
    description: '对象 key（uploadFile 表单的 key 字段；业务落库存它）',
    example: 'image/202608/user123/9f8b7a.png',
  })
  key: string;

  @ApiProperty({
    description: '直传入口地址（按存储区域解析）',
    example: 'https://up-z2.qiniup.com',
  })
  uploadUrl: string;

  @ApiProperty({
    description: '上传成功后的访问 URL（私有空间为带签名的临时 URL）',
  })
  accessUrl: string;

  @ApiProperty({ description: '凭证过期时间戳（毫秒）' })
  expiresAt: number;
}

export class AccessUrlResponseDto {
  @ApiProperty({ description: '对象访问 URL（私有空间为带签名的临时 URL）' })
  url: string;
}
