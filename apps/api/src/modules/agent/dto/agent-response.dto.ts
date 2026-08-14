import { AgentStrategy } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class AgentResponseDto {
  @ApiProperty({ example: 'cmf_agent_123' })
  id: string;

  @ApiProperty({ example: '通用助手' })
  name: string;

  @ApiProperty({ example: '默认对话助手' })
  description: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '头像 URL；null = 客户端显示名称首字',
  })
  avatar: string | null;

  @ApiProperty({ nullable: true, description: '系统提示词；null=用内置默认' })
  systemPrompt: string | null;

  @ApiProperty({ nullable: true, example: 'kimi' })
  modelPreset: string | null;

  @ApiProperty({ enum: AgentStrategy })
  defaultStrategy: AgentStrategy;

  @ApiProperty({ enum: AgentStrategy, isArray: true })
  allowedStrategies: AgentStrategy[];

  @ApiProperty({ example: ['default'] })
  toolGroups: string[];

  @ApiProperty({ example: [] })
  skills: string[];

  @ApiProperty({ nullable: true, example: 6 })
  maxSteps: number | null;

  @ApiProperty({ example: true })
  enabled: boolean;

  @ApiProperty({ example: false })
  isDefault: boolean;

  @ApiProperty({ example: 1735689600000 })
  createdAt: number;

  @ApiProperty({ example: 1735689600000 })
  updatedAt: number;
}
