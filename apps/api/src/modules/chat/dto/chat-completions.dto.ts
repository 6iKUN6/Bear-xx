import {
  IsString,
  IsNotEmpty,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ReasoningSelectionDto } from '../../llm/dto/reasoning-selection.dto';

export class ChatCompletionsDto {
  @ApiPropertyOptional({
    description: '会话 ID；首轮消息可不传，后端会自动创建新会话',
    example: 'conv_abc123',
  })
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiProperty({ description: '用户消息内容', example: '你好，请帮我写一首诗' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({
    description: '指定使用的智能体 id；不传则用默认智能体',
    example: 'agent_abc123',
  })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({
    description:
      '本条消息选择的模型预设业务 ID；必须属于回答智能体允许集合，仅替换 Flow 中的 agent-default',
    example: 'deepseek-official:deepseek-chat',
  })
  @IsOptional()
  @IsString()
  selectedModelPresetId?: string;

  @ApiPropertyOptional({
    type: ReasoningSelectionDto,
    description: '仅 direct Agent 可用的本轮思考设置',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ReasoningSelectionDto)
  reasoning?: ReasoningSelectionDto;
}
