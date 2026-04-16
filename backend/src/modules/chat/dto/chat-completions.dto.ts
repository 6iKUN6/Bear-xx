import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { LlmRequestFieldsDto } from './llm-request-fields.dto';

export class ChatCompletionsDto extends LlmRequestFieldsDto {
  @ApiProperty({ description: '会话 ID', example: 'conv_abc123' })
  @IsString()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({ description: '用户消息内容', example: '你好，请帮我写一首诗' })
  @IsString()
  @IsNotEmpty()
  content: string;
}
