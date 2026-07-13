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
}
