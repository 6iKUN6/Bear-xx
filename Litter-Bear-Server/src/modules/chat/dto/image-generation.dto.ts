import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ImageGenerationDto {
  @ApiProperty({ description: '会话 ID', example: 'conv_abc123' })
  @IsString()
  @IsNotEmpty()
  conversationId: string;

  @ApiProperty({
    description: '图片生成提示词',
    example: '一只可爱的小熊在森林里散步',
    maxLength: 4000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  prompt: string;
}
