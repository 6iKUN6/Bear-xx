import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthService } from '../auth/auth.service';
import {
  AdminAuthUserDto,
  AdminLoginDto,
  AdminLoginResultDto,
} from './dto/admin-auth.dto';

@ApiTags('管理-认证')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * 登录管理后台
   * @param dto 既有管理员账号和密码
   * @returns 返回后台 JWT 登录态和当前管理员角色
   * @description 仅登录现有 ADMIN 或 SUPER_ADMIN，不沿用普通账号入口的自动注册行为。
   */
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '管理员账号密码登录' })
  @ApiOkResponse({ description: '登录成功', type: AdminLoginResultDto })
  login(@Body() dto: AdminLoginDto) {
    return this.authService.adminLogin(dto.username, dto.password);
  }

  /**
   * 获取当前后台登录身份
   * @param userId 当前已认证用户ID
   * @returns 返回数据库中的实时管理员角色与基本资料
   * @description 后台恢复本地会话时调用；角色已撤销时由守卫直接拒绝，不使用缓存角色放行。
   */
  @Get('session')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前后台登录身份' })
  @ApiOkResponse({ description: '当前管理员身份', type: AdminAuthUserDto })
  session(@CurrentUser('id') userId: string) {
    return this.authService.getAdminAuthUser(userId);
  }
}
