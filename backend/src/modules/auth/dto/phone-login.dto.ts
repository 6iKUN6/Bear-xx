import { IsString, IsNotEmpty, Matches, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendCodeDto {
  @ApiProperty({ description: '手机号码', example: '13812345678' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone: string;
}

export class PhoneLoginDto {
  @ApiProperty({ description: '手机号码', example: '13812345678' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone: string;

  @ApiProperty({ description: '6位短信验证码', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: '验证码为6位数字' })
  code: string;
}
