import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ManagementAuditAction,
  ManagementAuditTargetType,
  MembershipTier,
  UserRole,
} from '@prisma/client';

export class AdminPageQueryDto {
  @ApiPropertyOptional({ type: Number, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ type: Number, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

export class AdminUserListQueryDto extends AdminPageQueryDto {
  @ApiPropertyOptional({ description: '搜索用户ID、昵称、账号或手机号' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class UpdateMembershipDto {
  @ApiProperty({ enum: MembershipTier })
  @IsEnum(MembershipTier)
  membershipTier: MembershipTier;

  @ApiPropertyOptional({
    description: 'ISO 8601 到期时间；null 表示永久',
    nullable: true,
  })
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsISO8601({}, { message: '会员到期时间格式无效' })
  membershipExpiresAt: string | null;
}

export class UpdateAdminRoleDto {
  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role: UserRole;
}

export class AdminUserResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() nickname: string;
  @ApiProperty() avatarUrl: string;
  @ApiProperty({ nullable: true }) username: string | null;
  @ApiProperty({ nullable: true }) phone: string | null;
  @ApiProperty({ enum: UserRole }) role: UserRole;
  @ApiProperty() hasPasswordAccount: boolean;
  @ApiProperty({ enum: MembershipTier }) membershipTier: MembershipTier;
  @ApiProperty({ enum: MembershipTier })
  effectiveMembershipTier: MembershipTier;
  @ApiProperty({ nullable: true, type: String })
  membershipExpiresAt: Date | null;
  @ApiProperty() membershipExpired: boolean;
  @ApiProperty({ type: String }) createdAt: Date;
}

export class AdminUserPageDto {
  @ApiProperty({ type: AdminUserResponseDto, isArray: true })
  items: AdminUserResponseDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() pageSize: number;
}

export class ManagementAuditActorDto {
  @ApiProperty() id: string;
  @ApiProperty() nickname: string;
  @ApiProperty({ nullable: true }) username: string | null;
}

export class ManagementAuditLogDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true }) actorId: string | null;
  @ApiProperty({ enum: ManagementAuditTargetType })
  targetType: ManagementAuditTargetType;
  @ApiProperty() targetId: string;
  @ApiProperty({ enum: ManagementAuditAction }) action: ManagementAuditAction;
  @ApiProperty({ nullable: true, type: Object }) before: Record<
    string,
    unknown
  > | null;
  @ApiProperty({ nullable: true, type: Object }) after: Record<
    string,
    unknown
  > | null;
  @ApiProperty({ type: String }) createdAt: Date;
  @ApiProperty({ type: ManagementAuditActorDto, nullable: true })
  actor: ManagementAuditActorDto | null;
}

export class ManagementAuditPageDto {
  @ApiProperty({ type: ManagementAuditLogDto, isArray: true })
  items: ManagementAuditLogDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() pageSize: number;
}
