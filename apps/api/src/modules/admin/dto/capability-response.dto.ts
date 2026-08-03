import { ApiProperty } from '@nestjs/swagger';

export class CapabilityToolDto {
  @ApiProperty({ example: 'webSearch' })
  name: string;

  @ApiProperty({ description: '工具功能说明（来自工具定义）' })
  description: string;

  @ApiProperty({ description: '执行前是否需要人工审批', example: false })
  requiresApproval: boolean;
}

export class ToolGroupDto {
  @ApiProperty({ example: 'default' })
  name: string;

  @ApiProperty({ type: CapabilityToolDto, isArray: true })
  tools: CapabilityToolDto[];
}

export class AgentCapabilitiesDto {
  @ApiProperty({
    type: ToolGroupDto,
    isArray: true,
    description: '可分配给智能体的工具组闭集（来自能力注册表）',
  })
  toolGroups: ToolGroupDto[];
}
