import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ResumeStreamTaskDto {
  @ApiPropertyOptional({
    description:
      '客户端已收到的最后一个 Redis Stream 帧 ID，用于断线后从该帧之后继续恢复',
    example: '1751450000000-0',
  })
  @IsOptional()
  @IsString()
  lastEventId?: string;
}
