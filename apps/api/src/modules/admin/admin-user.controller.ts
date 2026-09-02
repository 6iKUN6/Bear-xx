import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminUserService } from './admin-user.service';
import {
  AdminPageQueryDto,
  AdminUserPageDto,
  AdminUserResponseDto,
  AdminUserListQueryDto,
  ManagementAuditPageDto,
  UpdateAdminRoleDto,
  UpdateMembershipDto,
} from './dto/admin-user.dto';

@ApiTags('管理-用户与权限')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export class AdminUserController {
  constructor(private readonly service: AdminUserService) {}

  /**
   * 查询用户与权限列表
   * @param query 分页与搜索参数
   * @returns 返回用户角色、会员配置和有效会员投影
   * @description 供两级管理员管理会员及查看账号状态，不返回认证机密。
   */
  @Get('users')
  @ApiOperation({ summary: '分页查询用户与权限' })
  @ApiOkResponse({ description: '用户分页结果', type: AdminUserPageDto })
  list(@Query() query: AdminUserListQueryDto) {
    return this.service.list(query);
  }

  /**
   * 修改用户会员配置
   * @param actorId 当前管理员用户ID
   * @param id 目标用户ID
   * @param dto 会员等级与到期时间
   * @returns 返回更新后的用户权限投影
   * @description 两级管理员均可操作，业务更新与管理审计处于同一事务。
   */
  @Patch('users/:id/membership')
  @ApiOperation({ summary: '修改用户会员等级与到期时间' })
  @ApiOkResponse({
    description: '更新后的用户权限',
    type: AdminUserResponseDto,
  })
  updateMembership(
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: UpdateMembershipDto,
  ) {
    return this.service.updateMembership(actorId, id, {
      membershipTier: dto.membershipTier,
      membershipExpiresAt: dto.membershipExpiresAt
        ? new Date(dto.membershipExpiresAt)
        : null,
    });
  }

  /**
   * 修改用户后台角色
   * @param actorId 当前顶级管理员用户ID
   * @param id 目标用户ID
   * @param dto 新后台角色
   * @returns 返回更新后的用户权限投影
   * @description 仅顶级管理员可用，服务层在事务内再次复核并执行全部安全护栏。
   */
  @Patch('users/:id/admin-role')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: '授予、调整或撤销管理员角色' })
  @ApiOkResponse({
    description: '更新后的用户权限',
    type: AdminUserResponseDto,
  })
  updateAdminRole(
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAdminRoleDto,
  ) {
    return this.service.updateAdminRole(actorId, id, dto.role);
  }

  /**
   * 查询安全管理审计
   * @param query 分页参数
   * @returns 返回角色、会员和智能体策略变更记录
   * @description 供两级管理员追溯人工和系统操作，审计快照不包含密码或第三方密钥。
   */
  @Get('audit-logs')
  @ApiOperation({ summary: '分页查询管理审计记录' })
  @ApiOkResponse({ description: '审计分页结果', type: ManagementAuditPageDto })
  listAuditLogs(@Query() query: AdminPageQueryDto) {
    return this.service.listAuditLogs(query);
  }
}
