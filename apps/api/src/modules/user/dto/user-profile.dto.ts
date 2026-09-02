import { ApiProperty } from '@nestjs/swagger';
import { MembershipTier } from '@prisma/client';

export class UserProfileDto {
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

  @ApiProperty()
  membershipExpired: boolean;
}
