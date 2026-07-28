import { randomBytes, scrypt as scryptCallback } from 'crypto';
import { promisify } from 'util';
import { AgentStrategy, PrismaClient, UserRole } from '@prisma/client';

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
 * 管理员账号/密码从 ADMIN_USERNAME/ADMIN_PASSWORD 读，带兜底默认值。可重复执行。
 */
async function main() {
  const username = process.env.ADMIN_USERNAME?.trim() || 'admin';
  const password = process.env.ADMIN_PASSWORD?.trim() || 'admin12345';

  const existingAdmin = await prisma.user.findUnique({ where: { username } });
  if (existingAdmin) {
    await prisma.user.update({
      where: { username },
      data: { role: UserRole.ADMIN },
    });
    console.log(`[seed] 管理员已存在，确保角色为 ADMIN：${username}`);
  } else {
    await prisma.user.create({
      data: {
        username,
        nickname: '管理员',
        role: UserRole.ADMIN,
        passwordHash: await hashPassword(password),
        passwordUpdatedAt: new Date(),
      },
    });
    console.log(`[seed] 已创建管理员：${username}（默认密码见 ADMIN_PASSWORD）`);
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
        description: '默认对话智能体，行为与内置默认一致',
        systemPrompt: null,
        modelPreset: null,
        defaultStrategy: AgentStrategy.AUTO,
        allowedStrategies: [],
        toolGroups: [],
        skills: [],
        maxSteps: null,
        enabled: true,
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
