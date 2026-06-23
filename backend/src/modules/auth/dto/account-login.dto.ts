import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AccountLoginDto {
  @ApiProperty({
    description: '账号名，支持字母、数字和下划线，4 到 20 位',
    example: 'sparkle_01',
  })
  @IsString()
  @MinLength(4, { message: '账号长度至少为4位' })
  @MaxLength(20, { message: '账号长度不能超过20位' })
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: '账号仅支持字母、数字和下划线',
  })
  username: string;

  @ApiProperty({
    description: '登录密码，至少8位',
    example: '12345678',
  })
  @IsString()
  @MinLength(8, { message: '密码长度至少为8位' })
  @MaxLength(64, { message: '密码长度不能超过64位' })
  password: string;

  @ApiPropertyOptional({
    description: '首次自动注册时使用的昵称，不传则默认生成“用户+随机字符”',
    example: 'Sparkle',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: '昵称长度不能超过20位' })
  nickname?: string;
}
