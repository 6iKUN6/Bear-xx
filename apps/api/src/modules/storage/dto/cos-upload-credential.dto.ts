import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';
import {
  UPLOAD_MEDIA_TYPES,
  type UploadMediaType,
} from './upload-credential.dto';

/** 腾讯云 COS 单对象直传凭证请求。 */
export class CosUploadCredentialDto {
  @ApiProperty({
    description: '上传媒体类型（决定 COS 对象目录与 MIME 类型）',
    enum: UPLOAD_MEDIA_TYPES,
    example: 'image',
  })
  @IsIn(UPLOAD_MEDIA_TYPES)
  type: UploadMediaType;

  @ApiProperty({
    description: '文件扩展名（不含点），仅字母数字',
    example: 'png',
    pattern: '^[a-zA-Z0-9]{1,8}$',
    minLength: 1,
    maxLength: 8,
  })
  @IsString()
  @Matches(/^[a-z0-9]{1,8}$/i, { message: '扩展名仅支持 1-8 位字母数字' })
  ext: string;
}

/** 腾讯云 COS 单对象 PUT 直传凭证响应。 */
export class CosUploadCredentialResponseDto {
  @ApiProperty({
    description: '对象 key（仅本次预签名 PUT URL 可写入该对象）',
    example: 'image/202608/user123/9f8b7a.png',
  })
  key: string;

  @ApiProperty({
    description: '短期有效的 COS HTTPS PUT 直传地址',
    example: 'https://example.cos.ap-guangzhou.myqcloud.com/object',
  })
  uploadUrl: string;

  @ApiProperty({ description: '上传成功后的 COS 或 CDN 访问地址' })
  accessUrl: string;

  @ApiProperty({
    description: 'PUT 直传时必须原样携带的请求头',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'Content-Type': 'image/png' },
  })
  headers: Record<string, string>;

  @ApiProperty({ description: '凭证过期时间戳（毫秒）' })
  expiresAt: number;
}
