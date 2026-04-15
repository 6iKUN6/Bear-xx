import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

export class ResumeSseDto {
  @ApiPropertyOptional({
    description: '客户端已收到的最后一个事件 ID',
    example: 12,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  lastEventId?: number;
}
