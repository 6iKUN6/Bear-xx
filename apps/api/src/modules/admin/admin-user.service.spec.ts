import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ManagementAuditAction,
  MembershipTier,
  Prisma,
  UserRole,
} from '@prisma/client';
import { AgentAccessService } from '../agent-access/agent-access.service';
import { AdminUserService } from './admin-user.service';

describe('AdminUserService', () => {
  const tx = {
    user: {
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    managementAuditLog: {
      create: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn(
      async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx),
    ),
  };

  const createService = () =>
    new AdminUserService(prisma as never, new AgentAccessService());

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx),
    );
  });

  it('updates membership and writes a safe audit in the same transaction', async () => {
    const expiresAt = new Date('2026-12-01T00:00:00.000Z');
    tx.user.findUnique
      .mockResolvedValueOnce({ id: 'admin-1', role: UserRole.ADMIN })
      .mockResolvedValueOnce({
        id: 'user-1',
        nickname: '用户一',
        avatarUrl: '',
        username: null,
        phone: '13800000000',
        role: UserRole.USER,
        membershipTier: MembershipTier.FREE,
        membershipExpiresAt: null,
        passwordHash: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    tx.user.update.mockResolvedValue({
      id: 'user-1',
      nickname: '用户一',
      avatarUrl: '',
      username: null,
      phone: '13800000000',
      role: UserRole.USER,
      membershipTier: MembershipTier.PRO,
      membershipExpiresAt: expiresAt,
      passwordHash: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await createService().updateMembership('admin-1', 'user-1', {
      membershipTier: MembershipTier.PRO,
      membershipExpiresAt: expiresAt,
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(tx.managementAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-1',
        targetId: 'user-1',
        action: ManagementAuditAction.MEMBERSHIP_UPDATED,
        before: {
          membershipTier: MembershipTier.FREE,
          membershipExpiresAt: null,
        },
        after: {
          membershipTier: MembershipTier.PRO,
          membershipExpiresAt: expiresAt.toISOString(),
        },
      }),
    });
  });

  it('rejects a role update when the actor changes their own role', async () => {
    await expect(
      createService().updateAdminRole('super-1', 'super-1', UserRole.ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rechecks that the actor is still a super admin inside the transaction', async () => {
    tx.user.findUnique
      .mockResolvedValueOnce({ id: 'actor-1', role: UserRole.ADMIN })
      .mockResolvedValueOnce({
        id: 'user-1',
        role: UserRole.USER,
        username: 'candidate',
        passwordHash: 'hash',
      });

    await expect(
      createService().updateAdminRole('actor-1', 'user-1', UserRole.ADMIN),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('allows promoting a phone-password user without a username', async () => {
    tx.user.findUnique
      .mockResolvedValueOnce({ id: 'actor-1', role: UserRole.SUPER_ADMIN })
      .mockResolvedValueOnce({
        id: 'user-1',
        role: UserRole.USER,
        username: null,
        phone: '13800000000',
        passwordHash: 'hash',
      });
    tx.user.update.mockResolvedValue({
      id: 'user-1',
      nickname: '手机用户',
      avatarUrl: '',
      username: null,
      phone: '13800000000',
      role: UserRole.ADMIN,
      membershipTier: MembershipTier.FREE,
      membershipExpiresAt: null,
      passwordHash: 'hash',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      createService().updateAdminRole('actor-1', 'user-1', UserRole.ADMIN),
    ).resolves.toMatchObject({ role: UserRole.ADMIN });
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: UserRole.ADMIN } }),
    );
  });

  it('rejects promoting a user without any password login identifier', async () => {
    tx.user.findUnique
      .mockResolvedValueOnce({ id: 'actor-1', role: UserRole.SUPER_ADMIN })
      .mockResolvedValueOnce({
        id: 'user-1',
        role: UserRole.USER,
        username: null,
        phone: null,
        passwordHash: 'hash',
      });

    await expect(
      createService().updateAdminRole('actor-1', 'user-1', UserRole.ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('keeps at least one super admin', async () => {
    tx.user.findUnique
      .mockResolvedValueOnce({ id: 'actor-1', role: UserRole.SUPER_ADMIN })
      .mockResolvedValueOnce({
        id: 'super-2',
        role: UserRole.SUPER_ADMIN,
        username: 'super2',
        passwordHash: 'hash',
      });
    tx.user.count.mockResolvedValue(1);

    await expect(
      createService().updateAdminRole('actor-1', 'super-2', UserRole.ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('updates an admin role and records only the role snapshot', async () => {
    tx.user.findUnique
      .mockResolvedValueOnce({ id: 'actor-1', role: UserRole.SUPER_ADMIN })
      .mockResolvedValueOnce({
        id: 'user-1',
        role: UserRole.USER,
        username: 'candidate',
        passwordHash: 'secret-hash',
      });
    tx.user.update.mockResolvedValue({
      id: 'user-1',
      nickname: '候选管理员',
      avatarUrl: '',
      username: 'candidate',
      phone: null,
      role: UserRole.ADMIN,
      membershipTier: MembershipTier.FREE,
      membershipExpiresAt: null,
      passwordHash: 'secret-hash',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await createService().updateAdminRole('actor-1', 'user-1', UserRole.ADMIN);

    expect(tx.managementAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'actor-1',
        targetId: 'user-1',
        action: ManagementAuditAction.ADMIN_ROLE_UPDATED,
        before: { role: UserRole.USER },
        after: { role: UserRole.ADMIN },
      }),
    });
    expect(tx.managementAuditLog.create.mock.calls[0]).not.toContain(
      'secret-hash',
    );
  });
});
