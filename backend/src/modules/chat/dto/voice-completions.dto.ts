import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { LlmRequestFieldsDto } from './llm-request-fields.dto';

export class VoiceCompletionsDto extends LlmRequestFieldsDto {
  @ApiProperty({ description: '会话 ID', example: 'conv_abc123' })
  @IsString()
  @IsNotEmpty()
  conversationId: string;
}
