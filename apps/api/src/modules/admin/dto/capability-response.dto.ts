import { ApiProperty } from '@nestjs/swagger';
import { ModelReasoningCapabilityDto } from '../../llm/dto/reasoning-selection.dto';

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

export class ModelPresetOptionDto {
  @ApiProperty({
    example: 'gpt-5.6-terra',
    description: '预设标识，写进节点 modelPreset',
  })
  id: string;

  @ApiProperty({
    example: 'GPT-5.5',
    description: '模型预设显示名称',
  })
  name: string;

  @ApiProperty({
    example: 'OpenAI 官方',
    description: '所属供应商连接显示名称',
  })
  connectionName: string;

  @ApiProperty({
    example: 'openai',
    description: '供应商模板标识，用于显示固定 Logo',
  })
  providerKey: string;

  @ApiProperty({
    example: 'gpt-5.6',
    description: '底层模型名，仅用于界面区分同名预设',
  })
  model: string;

  @ApiProperty({ type: ModelReasoningCapabilityDto, nullable: true })
  reasoningCapability: ModelReasoningCapabilityDto | null;
}

export class AgentCapabilitiesDto {
  @ApiProperty({
    type: ToolGroupDto,
    isArray: true,
    description: '可分配给智能体的工具组闭集（来自能力注册表）',
  })
  toolGroups: ToolGroupDto[];

  @ApiProperty({
    type: ModelPresetOptionDto,
    isArray: true,
    description:
      '可选的模型预设闭集。与 FlowRuntimeValidator 同一判据（listAvailableModels），因此不会列出发布期会被拒的选项；注册表加载时已过滤禁用模型和连接。刻意不下发 baseURL 与 apiKeyHint。',
  })
  modelPresets: ModelPresetOptionDto[];
}
