import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipTier } from '@prisma/client';

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
    description: '模型预设 id；留空则用请求指定或全局默认模型',
    example: 'kimi',
  })
  @IsOptional()
  @IsString()
  modelPreset?: string;

  @ApiPropertyOptional({
    description:
      '默认执行的已发布 FlowVersion ID；null 表示继续使用历史策略配置',
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
