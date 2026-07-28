import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';

const PROVIDERS = ['openai', 'anthropic'] as const;
const PLATFORMS = [
  'openai',
  'anthropic',
  'deepseek',
  'kimi',
  'doubao',
] as const;

export class CreateModelPresetDto {
  @ApiProperty({
    description: '业务预设 id（供 agent 引用）',
    example: 'openai:gpt-5.5',
  })
  @IsString()
  @IsNotEmpty()
  presetId: string;

  @ApiProperty({ description: '显示名', example: 'GPT-5.5' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: '描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'provider', enum: PROVIDERS })
  @IsIn(PROVIDERS)
  provider: string;

  @ApiProperty({ description: 'platform', enum: PLATFORMS })
  @IsIn(PLATFORMS)
  platform: string;

  @ApiProperty({ description: '模型名', example: 'gpt-5.5' })
  @IsString()
  @IsNotEmpty()
  model: string;

  @ApiPropertyOptional({ description: '自定义 baseURL；留空用 env 默认' })
  @IsOptional()
  @IsString()
  baseURL?: string;

  @ApiPropertyOptional({ description: 'temperature' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ description: '最大输出 token' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxOutputTokens?: number;

  @ApiPropertyOptional({ description: 'topP' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  topP?: number;

  @ApiPropertyOptional({ description: '是否启用', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: '是否默认预设', default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateModelPresetDto extends PartialType(CreateModelPresetDto) {}

export class ModelPresetResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() presetId: string;
  @ApiProperty() name: string;
  @ApiProperty() description: string;
  @ApiProperty() provider: string;
  @ApiProperty() platform: string;
  @ApiProperty() model: string;
  @ApiProperty({ nullable: true }) baseURL: string | null;
  @ApiProperty({ nullable: true }) temperature: number | null;
  @ApiProperty({ nullable: true }) maxOutputTokens: number | null;
  @ApiProperty({ nullable: true }) topP: number | null;
  @ApiProperty() enabled: boolean;
  @ApiProperty() isDefault: boolean;
  @ApiProperty({
    description: '该 platform 对应的 env 密钥是否已配置（apiKey 不落库）',
    example: true,
  })
  apiKeyConfigured: boolean;
  @ApiProperty() createdAt: number;
  @ApiProperty() updatedAt: number;
}
