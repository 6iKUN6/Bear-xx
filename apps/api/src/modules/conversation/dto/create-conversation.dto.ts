import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationType } from '@prisma/client';

export class CreateConversationDto {
  @ApiPropertyOptional({ description: '会话标题', example: '新对话' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  title?: string;

  @ApiPropertyOptional({
    description: '会话形态；默认 SINGLE。GROUP 需带 agentIds 初始成员',
    enum: ConversationType,
  })
  @IsOptional()
  @IsIn(Object.values(ConversationType))
  type?: ConversationType;

  @ApiPropertyOptional({
    description:
      'SINGLE：绑定的智能体（单个，重复创建返回既有单聊）；GROUP：初始成员（2-10 个）',
    example: ['agent_abc'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  agentIds?: string[];
}

export class UpdateConversationDto {
  @ApiPropertyOptional({ description: '会话/群聊标题' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  title?: string;

  @ApiPropertyOptional({
    description: '群聊默认回答者 agent id；空串 = 恢复自动路由',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  defaultAgentId?: string;
}

export class AddConversationAgentDto {
  @ApiPropertyOptional({ description: '要加入群聊的智能体 id' })
  @IsString()
  agentId: string;
}
