import { ApiProperty } from '@nestjs/swagger';
import { MembershipTier } from '@prisma/client';

export class AuthUserDto {
  @ApiProperty({ description: '用户 ID', example: 'cmf_user_123' })
  id: string;

  @ApiProperty({ description: '用户昵称', example: '小熊用户' })
  nickname: string;

  @ApiProperty({ description: '用户头像地址', example: '' })
  avatarUrl: string;

  @ApiProperty({ enum: MembershipTier })
  membershipTier: MembershipTier;

  @ApiProperty({ enum: MembershipTier })
  effectiveMembershipTier: MembershipTier;

  @ApiProperty({ nullable: true, type: String })
  membershipExpiresAt: Date | null;

  @ApiProperty({ description: '会员配置是否已到期' })
  membershipExpired: boolean;
}

export class LoginResultDto {
  @ApiProperty({ description: '访问令牌', example: 'eyJhbGciOiJIUzI1NiIs...' })
  token: string;

  @ApiProperty({ description: '刷新令牌', example: 'eyJhbGciOiJIUzI1NiIs...' })
  refreshToken: string;

  @ApiProperty({ description: '登录用户信息', type: AuthUserDto })
  user: AuthUserDto;
}
