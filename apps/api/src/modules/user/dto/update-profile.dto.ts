import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: '用户昵称', example: '小熊同学' })
  @IsOptional()
  @IsString()
  nickname?: string;

  @ApiPropertyOptional({
    description: '头像 URL',
    example: 'https://example.com/avatar.png',
  })
  @IsOptional()
  @IsString()
  avatarUrl?: string;
}
