import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipTier } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsObject, ValidateNested } from 'class-validator';
import { ReasoningSelectionDto } from '../../llm/dto/reasoning-selection.dto';

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
    type: String,
    nullable: true,
    description: '头像 URL；留空则客户端显示名称首字',
    example: 'https://example.com/avatar.png',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar?: string | null;

  @ApiPropertyOptional({
    description: '系统提示词；留空则回退到内置默认提示词',
  })
  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description:
      '允许终端为 agent-default 选择的模型预设业务 ID；有效 Flow 不使用 agent-default 时必须为空',
    type: String,
    isArray: true,
    example: ['deepseek-official:deepseek-chat'],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  allowedModelPresetIds?: string[];

  @ApiPropertyOptional({
    type: String,
    description:
      'Agent 默认模型预设业务 ID；必须属于 allowedModelPresetIds，终端未选择时用于解析 agent-default',
    nullable: true,
    example: 'deepseek-official:deepseek-chat',
  })
  @IsOptional()
  @IsString()
  defaultModelPresetId?: string | null;

  @ApiPropertyOptional({
    type: ReasoningSelectionDto,
    nullable: true,
    description: 'direct Agent 默认模型的思考设置',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ReasoningSelectionDto)
  defaultReasoning?: ReasoningSelectionDto | null;

  @ApiPropertyOptional({
    description:
      '默认执行的已发布 FlowVersion ID；null 表示执行系统内置的直接回复 Flow',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  defaultFlowVersionId?: string | null;

  @ApiPropertyOptional({ description: '是否启用', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: '是否展示在终端发现列表', default: true })
  @IsOptional()
  @IsBoolean()
  visible?: boolean;

  @ApiPropertyOptional({
    description: '终端使用所需最低会员等级',
    enum: MembershipTier,
    default: MembershipTier.FREE,
  })
  @IsOptional()
  @IsEnum(MembershipTier)
  minimumMembershipTier?: MembershipTier;
}
