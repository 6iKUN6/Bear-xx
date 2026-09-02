const { PrismaClient, UserRole, ManagementAuditAction, ManagementAuditTargetType } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.$transaction(
    async (tx) => {
      const admins = await tx.user.findMany({
        where: { role: UserRole.ADMIN },
        select: { id: true, role: true },
      });

      for (const admin of admins) {
        await tx.user.update({
          where: { id: admin.id },
          data: { role: UserRole.SUPER_ADMIN },
        });
        await tx.managementAuditLog.create({
          data: {
            actorId: null,
            targetType: ManagementAuditTargetType.USER,
            targetId: admin.id,
            action: ManagementAuditAction.SUPER_ADMIN_BOOTSTRAPPED,
            before: { role: UserRole.ADMIN },
            after: { role: UserRole.SUPER_ADMIN },
          },
        });
      }

      return admins.length;
    },
    { isolationLevel: 'Serializable' },
  );

  console.log(`[bootstrap] 已升级 ${result} 个管理员账号为 SUPER_ADMIN。`);
}

main()
  .catch((error) => {
    console.error('[bootstrap] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
