import { ApiProperty } from '@nestjs/swagger';
import { MembershipTier } from '@prisma/client';
import { AgentAccessDenialReason } from '../../agent-access/agent-access.service';

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
