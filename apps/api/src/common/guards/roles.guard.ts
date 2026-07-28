import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';

interface RequestWithUser {
  user?: { id?: string };
}

/**
 * 角色守卫
 * @description 读取 @Roles 元数据；无要求则放行。否则用 req.user.id 实时查库取 role，
 * 命中要求角色之一才放行。查库而非读 token，保证角色变更即时生效（管理端点低频，成本可忽略）。
 * 必须置于 JwtAuthGuard 之后（依赖 req.user 已注入）。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<
      string[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userId = request.user?.id;
    if (!userId) {
      throw new UnauthorizedException('未认证');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException('无权访问该资源');
    }

    return true;
  }
}
