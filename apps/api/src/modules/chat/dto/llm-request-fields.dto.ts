import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class LlmRequestFieldsDto {
  @ApiPropertyOptional({
    description: '模型预设 ID，优先级最高，例如 openai:gpt-4o-mini',
    example: 'openai:gpt-4o-mini',
  })
  @IsOptional()
  @IsString()
  modelId?: string;

  @ApiPropertyOptional({
    description: 'LLM Provider 名称，例如 openai',
    example: 'openai',
  })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({
    description: '模型平台或商家名称，例如 openai、deepseek',
    example: 'openai',
  })
  @IsOptional()
  @IsString()
  platform?: string;

  @ApiPropertyOptional({
    description: '模型名称，例如 gpt-4o-mini',
    example: 'gpt-4o-mini',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description: '采样温度，建议范围 0 到 2',
    example: 0.7,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({
    description: '最大输出 Token 数',
    example: 2048,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxOutputTokens?: number;

  @ApiPropertyOptional({
    description: 'Top P 采样参数，范围 0 到 1',
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  topP?: number;
}
