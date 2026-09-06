import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class AdminLoginDto {
  @ApiProperty({
    description: '既有管理员用户名或手机号',
    example: 'admin',
  })
  @IsString()
  @MinLength(4, { message: '账号长度至少为4位' })
  @MaxLength(20, { message: '账号长度不能超过20位' })
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: '账号仅支持用户名或手机号',
  })
  username: string;

  @ApiProperty({ description: '管理员登录密码', example: '12345678' })
  @IsString()
  @MinLength(8, { message: '密码长度至少为8位' })
  @MaxLength(64, { message: '密码长度不能超过64位' })
  password: string;
}

export class AdminAuthUserDto {
  @ApiProperty({ description: '管理员用户 ID', example: 'cmf_admin_123' })
  id: string;

  @ApiProperty({ description: '管理员昵称', example: '管理员' })
  nickname: string;

  @ApiProperty({ description: '管理员头像地址', example: '' })
  avatarUrl: string;

  @ApiProperty({
    description: '当前后台角色',
    enum: [UserRole.ADMIN, UserRole.SUPER_ADMIN],
    example: UserRole.SUPER_ADMIN,
  })
  adminRole: Extract<UserRole, 'ADMIN' | 'SUPER_ADMIN'>;
}

export class AdminLoginResultDto {
  @ApiProperty({ description: '访问令牌', example: 'eyJhbGciOiJIUzI1NiIs...' })
  token: string;

  @ApiProperty({ description: '刷新令牌', example: 'eyJhbGciOiJIUzI1NiIs...' })
  refreshToken: string;

  @ApiProperty({ description: '管理员信息', type: AdminAuthUserDto })
  user: AdminAuthUserDto;
}
