import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VoiceCompletionsDto {
  @ApiProperty({ description: '会话 ID', example: 'conv_abc123' })
  @IsString()
  @IsNotEmpty()
  conversationId: string;
}
