import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StorageAssetKind, StorageAssetStatus } from '@prisma/client';
import { STORAGE_USAGES, type StorageUsage } from './upload-credential.dto';

export class RegisterAssetDto {
  @ApiProperty({
    description: '直传成功的对象 key（来自 upload-credential 响应）',
    example: 'image/202608/user123/9f8b7a.png',
  })
  @IsString()
  @MaxLength(255)
  @Matches(/^(image|audio)\/\d{6}\/[^/]+\/[0-9a-f]{32}\.[a-z0-9]{1,8}$/, {
    message: '对象 key 格式不合法',
  })
  key: string;

  @ApiPropertyOptional({ description: '业务用途', enum: STORAGE_USAGES })
  @IsOptional()
  @IsIn(STORAGE_USAGES)
  usage?: StorageUsage;

  @ApiPropertyOptional({ description: '文件字节数', example: 102400 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  size?: number;

  @ApiPropertyOptional({ description: 'MIME 类型', example: 'image/png' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string;
}

export class ListAssetsQueryDto {
  @ApiPropertyOptional({ description: '按业务用途过滤', enum: STORAGE_USAGES })
  @IsOptional()
  @IsIn(STORAGE_USAGES)
  usage?: StorageUsage;

  @ApiPropertyOptional({
    description: '资产状态；默认只列可用',
    enum: StorageAssetStatus,
    default: StorageAssetStatus.ACTIVE,
  })
  @IsOptional()
  @IsIn(Object.values(StorageAssetStatus))
  status?: StorageAssetStatus;

  @ApiPropertyOptional({ description: '返回条数上限', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class UpdateAssetStatusDto {
  @ApiProperty({
    description: '目标状态：BROKEN=远端失效；DELETED=逻辑删除',
    enum: [
      StorageAssetStatus.BROKEN,
      StorageAssetStatus.DELETED,
      StorageAssetStatus.ACTIVE,
    ],
  })
  @IsIn(Object.values(StorageAssetStatus))
  status: StorageAssetStatus;
}

export class StorageAssetDto {
  @ApiProperty() id: string;
  @ApiProperty() key: string;
  @ApiProperty({ description: 'COS 公有读访问 URL' })
  url: string;
  @ApiProperty({ enum: StorageAssetKind }) kind: StorageAssetKind;
  @ApiProperty() usage: string;
  @ApiProperty({ nullable: true }) mimeType: string | null;
  @ApiProperty({ nullable: true }) size: number | null;
  @ApiProperty({ enum: StorageAssetStatus }) status: StorageAssetStatus;
  @ApiProperty({ example: 1735689600000 }) createdAt: number;
}
