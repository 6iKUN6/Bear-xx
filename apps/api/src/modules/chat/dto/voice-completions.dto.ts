import { IsString, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { LlmRequestFieldsDto } from './llm-request-fields.dto';

export class VoiceCompletionsDto extends LlmRequestFieldsDto {
  @ApiPropertyOptional({
    description: '会话 ID；首轮语音消息可不传，后端会自动创建新会话',
    example: 'conv_abc123',
  })
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional({
    description: '指定使用的智能体 id；不传则用默认智能体',
    example: 'agent_abc123',
  })
  @IsOptional()
  @IsString()
  agentId?: string;
}
