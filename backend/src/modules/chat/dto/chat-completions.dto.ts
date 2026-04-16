import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LlmRequestFieldsDto } from './llm-request-fields.dto';

export class ChatCompletionsDto extends LlmRequestFieldsDto {
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
}
