import { AgentStrategy } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAgentDto {
  @ApiProperty({ description: '智能体名称', example: '通用助手' })
  @IsString()
  @MaxLength(50)
  name: string;

  @ApiPropertyOptional({ description: '描述', example: '默认对话助手' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({
    description: '系统提示词；留空则回退到内置默认提示词',
  })
  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description: '模型预设 id；留空则用请求指定或全局默认模型',
    example: 'kimi',
  })
  @IsOptional()
  @IsString()
  modelPreset?: string;

  @ApiPropertyOptional({
    description: '默认/强制策略；AUTO=自动路由，具体值=强制',
    enum: AgentStrategy,
    default: AgentStrategy.AUTO,
  })
  @IsOptional()
  @IsEnum(AgentStrategy)
  defaultStrategy?: AgentStrategy;

  @ApiPropertyOptional({
    description: '允许使用的策略集合；空=不限制（全部已安装）',
    enum: AgentStrategy,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsEnum(AgentStrategy, { each: true })
  allowedStrategies?: AgentStrategy[];

  @ApiPropertyOptional({
    description: '允许的工具组；空=不覆盖',
    example: ['default'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  toolGroups?: string[];

  @ApiPropertyOptional({ description: '附加技能名；空=不覆盖' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @ApiPropertyOptional({
    description: '步数预算；留空=不覆盖',
    example: 6,
    minimum: 1,
    maximum: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxSteps?: number;

  @ApiPropertyOptional({ description: '是否启用', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
