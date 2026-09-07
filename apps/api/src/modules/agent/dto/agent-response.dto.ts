import { ApiProperty } from '@nestjs/swagger';
import { MembershipTier } from '@prisma/client';
import { AgentAccessDenialReason } from '../../agent-access/agent-access.service';
import {
  ModelReasoningCapabilityDto,
  ReasoningSelectionDto,
} from '../../llm/dto/reasoning-selection.dto';

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

  @ApiProperty({
    nullable: true,
    description: 'Agent 默认模型预设业务 ID；null 表示不提供 agent-default',
    example: 'deepseek-official:deepseek-chat',
  })
  defaultModelPresetId: string | null;

  @ApiProperty({ type: ReasoningSelectionDto, nullable: true })
  defaultReasoning: ReasoningSelectionDto | null;

  @ApiProperty({
    type: String,
    isArray: true,
    description: '允许终端选择并用于解析 agent-default 的模型预设业务 ID',
    example: ['deepseek-official:deepseek-chat'],
  })
  allowedModelPresetIds: string[];

  @ApiProperty({
    nullable: true,
    description:
      '默认执行的已发布 FlowVersion ID；null=执行内置的直接回复 Flow',
  })
  defaultFlowVersionId: string | null;

  @ApiProperty({
    example: ['default'],
    description:
      '该智能体可用的工具组，仅供列表展示。当前仍读 Agent 上的历史字段，待改为从绑定的 Flow 节点推导',
  })
  toolGroups: string[];

  @ApiProperty({ example: true })
  enabled: boolean;

  @ApiProperty({ example: true, description: '是否进入终端发现列表' })
  visible: boolean;

  @ApiProperty({ enum: MembershipTier, example: MembershipTier.FREE })
  minimumMembershipTier: MembershipTier;

  @ApiProperty({ example: true, description: '当前用户是否可以使用' })
  canUse: boolean;

  @ApiProperty({
    enum: AgentAccessDenialReason,
    nullable: true,
    description: '不可用时的结构化原因；可用时为 null',
  })
  accessReason: AgentAccessDenialReason | null;

  @ApiProperty({ enum: MembershipTier, nullable: true })
  requiredTier: Extract<MembershipTier, 'PLUS' | 'PRO'> | null;

  @ApiProperty({ example: false })
  isDefault: boolean;

  @ApiProperty({ example: 1735689600000 })
  createdAt: number;

  @ApiProperty({ example: 1735689600000 })
  updatedAt: number;
}

/** 终端可安全展示和提交的 Agent 模型选项。 */
export class AgentModelOptionDto {
  @ApiProperty({ example: 'deepseek-official:deepseek-chat' })
  modelPresetId: string;

  @ApiProperty({ example: 'DeepSeek Chat' })
  name: string;

  @ApiProperty({ example: 'deepseek' })
  providerKey: string;

  @ApiProperty({ example: 'deepseek-chat' })
  model: string;

  @ApiProperty({ type: ModelReasoningCapabilityDto, nullable: true })
  reasoningCapability: ModelReasoningCapabilityDto | null;

  @ApiProperty({ description: '是否支持当前聊天图片输入' })
  supportsVision: boolean;
}

/** 指定 Agent 当前允许终端选择的可用模型。 */
export class AgentModelOptionsDto {
  @ApiProperty({ example: 'cmf_agent_123' })
  agentId: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'deepseek-official:deepseek-chat',
  })
  defaultModelPresetId: string | null;

  @ApiProperty({ type: ReasoningSelectionDto, nullable: true })
  defaultReasoning: ReasoningSelectionDto | null;

  @ApiProperty({ type: AgentModelOptionDto, isArray: true })
  models: AgentModelOptionDto[];
}
