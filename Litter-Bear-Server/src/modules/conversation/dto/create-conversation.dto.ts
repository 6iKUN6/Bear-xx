import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateConversationDto {
  @ApiPropertyOptional({ description: '会话标题', example: '新对话' })
  @IsOptional()
  @IsString()
  title?: string;
}
