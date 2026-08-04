import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;

export class CreateImageDto {
  @ApiProperty({ description: '生图提示词', example: '一只在太空里的小熊' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  prompt: string;

  @ApiPropertyOptional({ description: '图片尺寸', enum: IMAGE_SIZES })
  @IsOptional()
  @IsIn(IMAGE_SIZES)
  size?: (typeof IMAGE_SIZES)[number];
}

export class GeneratedImageDto {
  @ApiProperty({ description: '转存后的访问 URL' })
  url: string;

  @ApiProperty({ description: '七牛对象 key（已登记 StorageAsset）' })
  key: string;

  @ApiProperty({ description: '模型润色后的提示词', required: false })
  revisedPrompt?: string;
}

export class EditImageDto extends CreateImageDto {
  @ApiPropertyOptional({
    description: '参考图对象 key（七牛资产）；与 sourceUrls 合计 1-4 张',
    example: ['image/202608/user123/9f8b.png'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @Matches(/^(image)\/\d{6}\/[^/]+\/[0-9a-f]{32}\.[a-z0-9]{1,8}$/, {
    each: true,
    message: '参考图 key 格式不合法',
  })
  sourceKeys?: string[];

  @ApiPropertyOptional({
    description: '参考图完整 URL；与 sourceKeys 合计 1-4 张',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsUrl({ require_protocol: true }, { each: true })
  sourceUrls?: string[];
}
