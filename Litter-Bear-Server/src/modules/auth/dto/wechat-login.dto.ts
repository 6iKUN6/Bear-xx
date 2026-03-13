import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class WechatLoginDto {
  @ApiProperty({
    description: '微信登录临时凭证 code',
    example: '0a1B2c3D4e5F6g',
  })
  @IsString()
  @IsNotEmpty()
  code: string;
}
