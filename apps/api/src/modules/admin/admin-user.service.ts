import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ManagementAuditAction,
  ManagementAuditTargetType,
  MembershipTier,
  Prisma,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentAccessService } from '../agent-access/agent-access.service';

const ADMIN_USER_SELECT = {
  id: true,
  nickname: true,
  avatarUrl: true,
  username: true,
  phone: true,
  role: true,
  membershipTier: true,
  membershipExpiresAt: true,
  passwordHash: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

interface MembershipUpdate {
  membershipTier: MembershipTier;
  membershipExpiresAt: Date | null;
}

interface AdminUserListQuery {
  page: number;
  pageSize: number;
  search?: string;
}

interface AuditLogListQuery {
  page: number;
  pageSize: number;
}

type SelectedAdminUser = Prisma.UserGetPayload<{
  select: typeof ADMIN_USER_SELECT;
}>;

@Injectable()
export class AdminUserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentAccess: AgentAccessService,
  ) {}

  /**
   * 分页查询后台可管理的用户
   * @param query 页码、每页数量和可选搜索词
   * @returns 返回用户列表、总数和分页信息
   * @description 搜索用户ID、昵称、账号和手机号；只投影管理所需字段，不返回密码哈希等凭据。
   */
  async list(query: AdminUserListQuery) {
    const search = query.search?.trim();
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { id: { contains: search, mode: 'insensitive' } },
            { nickname: { contains: search, mode: 'insensitive' } },
            { username: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
          ],
        }
      : {};
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: ADMIN_USER_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: users.map((user) => this.toResponse(user)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * 更新用户会员配置
   * @param actorId 当前管理员用户ID
   * @param targetId 目标用户ID
   * @param update 固定会员等级和可空到期时间
   * @returns 返回更新后的管理端用户投影
   * @description 在可串行化事务中重查操作者、更新会员并写安全审计，审计失败时业务变更一并回滚。
   */
  async updateMembership(
    actorId: string,
    targetId: string,
    update: MembershipUpdate,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.assertAdminActor(tx, actorId);
        const target = await tx.user.findUnique({
          where: { id: targetId },
          select: ADMIN_USER_SELECT,
        });
        if (!target) {
          throw new NotFoundException('用户不存在');
        }

        const updated = await tx.user.update({
          where: { id: targetId },
          data: update,
          select: ADMIN_USER_SELECT,
        });
        await tx.managementAuditLog.create({
          data: {
            actorId,
            targetType: ManagementAuditTargetType.USER,
            targetId,
            action: ManagementAuditAction.MEMBERSHIP_UPDATED,
            before: this.membershipSnapshot(target),
            after: this.membershipSnapshot(updated),
          },
        });
        return this.toResponse(updated);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * 修改用户的后台角色
   * @param actorId 当前顶级管理员用户ID
   * @param targetId 目标用户ID
   * @param role 新角色，可授予两级管理员或撤销为普通用户
   * @returns 返回更新后的管理端用户投影
   * @description 在可串行化事务内执行身份复核、自改保护、账号密码要求、最后超管保护和安全审计。
   */
  async updateAdminRole(actorId: string, targetId: string, role: UserRole) {
    if (actorId === targetId) {
      throw new BadRequestException('不能修改自己的管理员角色');
    }

    return this.prisma.$transaction(
      async (tx) => {
        const [actor, target] = await Promise.all([
          tx.user.findUnique({
            where: { id: actorId },
            select: { id: true, role: true },
          }),
          tx.user.findUnique({
            where: { id: targetId },
            select: ADMIN_USER_SELECT,
          }),
        ]);
        if (actor?.role !== UserRole.SUPER_ADMIN) {
          throw new ForbiddenException('仅顶级管理员可修改管理员角色');
        }
        if (!target) {
          throw new NotFoundException('用户不存在');
        }
        if (
          role !== UserRole.USER &&
          (!target.username || !target.passwordHash)
        ) {
          throw new BadRequestException('只有已登记账号密码的用户可成为管理员');
        }
        if (
          target.role === UserRole.SUPER_ADMIN &&
          role !== UserRole.SUPER_ADMIN
        ) {
          const superAdminCount = await tx.user.count({
            where: { role: UserRole.SUPER_ADMIN },
          });
          if (superAdminCount <= 1) {
            throw new BadRequestException('系统必须至少保留一名顶级管理员');
          }
        }

        const updated = await tx.user.update({
          where: { id: targetId },
          data: { role },
          select: ADMIN_USER_SELECT,
        });
        await tx.managementAuditLog.create({
          data: {
            actorId,
            targetType: ManagementAuditTargetType.USER,
            targetId,
            action: ManagementAuditAction.ADMIN_ROLE_UPDATED,
            before: { role: target.role },
            after: { role: updated.role },
          },
        });
        return this.toResponse(updated);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * 分页查询安全管理审计
   * @param query 页码和每页数量
   * @returns 返回带操作者摘要的审计列表和分页信息
   * @description 只读取统一管理审计表中已白名单化的前后快照，不接触 Flow 域审计或认证凭据。
   */
  async listAuditLogs(query: AuditLogListQuery) {
    const [logs, total] = await this.prisma.$transaction([
      this.prisma.managementAuditLog.findMany({
        include: {
          actor: { select: { id: true, nickname: true, username: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.managementAuditLog.count(),
    ]);
    return {
      items: logs,
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async assertAdminActor(
    tx: Prisma.TransactionClient,
    actorId: string,
  ): Promise<void> {
    const actor = await tx.user.findUnique({
      where: { id: actorId },
      select: { id: true, role: true },
    });
    if (
      actor?.role !== UserRole.ADMIN &&
      actor?.role !== UserRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException('管理员权限已失效');
    }
  }

  private membershipSnapshot(user: MembershipUpdate): Prisma.JsonObject {
    return {
      membershipTier: user.membershipTier,
      membershipExpiresAt: user.membershipExpiresAt?.toISOString() ?? null,
    };
  }

  private toResponse(user: SelectedAdminUser) {
    const now = new Date();
    return {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      username: user.username,
      phone: user.phone,
      role: user.role,
      hasPasswordAccount: Boolean(user.username && user.passwordHash),
      membershipTier: user.membershipTier,
      effectiveMembershipTier: this.agentAccess.effectiveTier(user, now),
      membershipExpiresAt: user.membershipExpiresAt,
      membershipExpired: this.agentAccess.isExpired(user, now),
      createdAt: user.createdAt,
    };
  }
}
