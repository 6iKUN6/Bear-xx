import {
  IsString,
  IsNotEmpty,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
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

  @ApiProperty({ description: '登录密码，至少8位', example: '12345678' })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: '密码长度至少为8位' })
  @MaxLength(64, { message: '密码长度不能超过64位' })
  password: string;
}
