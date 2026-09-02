import { randomBytes, scrypt as scryptCallback } from 'crypto';
import { promisify } from 'util';
import { PrismaClient, UserRole, MembershipTier } from '@prisma/client';

const prisma = new PrismaClient();
const scrypt = promisify(scryptCallback);

// 与 auth.service 的 scrypt 哈希格式保持一致（prefix$salt$hashHex）。
const PASSWORD_SALT_LENGTH = 16;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_HASH_PREFIX = 'scrypt';

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_SALT_LENGTH).toString('hex');
  const derivedKey = (await scrypt(
    password,
    salt,
    PASSWORD_KEY_LENGTH,
  )) as Buffer;
  return [PASSWORD_HASH_PREFIX, salt, derivedKey.toString('hex')].join('$');
}

/**
 * 幂等 seed：管理员用户 + 默认智能体。
 * @description 默认智能体全部字段为"不覆盖"（AUTO/空/null，systemPrompt 留空用内置 .md），复刻当前默认行为。
 * 只有同时明确配置 ADMIN_USERNAME 与 ADMIN_PASSWORD 时才创建初始 SUPER_ADMIN；不会覆盖已有用户角色。
 */
async function main() {
  const username = process.env.ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD?.trim();

  if (username && password) {
    const existingAdmin = await prisma.user.findUnique({ where: { username } });
    if (existingAdmin) {
      console.log(`[seed] 管理员账号已存在，保留既有角色与密码：${username}`);
    } else {
      await prisma.user.create({
        data: {
          username,
          nickname: '管理员',
          role: UserRole.SUPER_ADMIN,
          passwordHash: await hashPassword(password),
          passwordUpdatedAt: new Date(),
        },
      });
      console.log(`[seed] 已创建初始顶级管理员：${username}`);
    }
  } else {
    console.log(
      '[seed] 未同时配置 ADMIN_USERNAME 与 ADMIN_PASSWORD，跳过管理员创建；不会生成默认弱口令账号。',
    );
  }

  const defaultAgent = await prisma.agent.findFirst({
    where: { isDefault: true },
  });
  if (defaultAgent) {
    console.log(`[seed] 默认智能体已存在：${defaultAgent.name}`);
  } else {
    await prisma.agent.create({
      data: {
        name: '通用助手',
        description: '默认对话智能体；未绑定 Flow 时执行内置的直接回复',
        systemPrompt: null,
        // 留空即执行内置的「直接回复」Flow；模型由部署方在后台配置后再填
        modelPreset: null,
        enabled: true,
        visible: true,
        minimumMembershipTier: MembershipTier.FREE,
        isDefault: true,
      },
    });
    console.log('[seed] 已创建默认智能体：通用助手');
  }
}

main()
  .catch((error) => {
    console.error('[seed] 失败：', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
