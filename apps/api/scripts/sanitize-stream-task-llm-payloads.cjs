const { PrismaClient } = require('@prisma/client');

const BATCH_SIZE = 200;

/**
 * 删除任务载荷顶层的历史 llm 字段
 * @param {unknown} value StreamTask.requestPayload 的 JSON 值
 * @returns {{ changed: boolean, payload?: Record<string, unknown> }} 返回是否需要清理及清理后的对象
 * @description 只处理普通对象的顶层 llm 字段，不递归、不读取或输出字段内容，也不改动其他业务字段。
 */
function sanitizePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { changed: false };
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'llm')) {
    return { changed: false };
  }
  const payload = { ...value };
  delete payload.llm;
  return { changed: true, payload };
}

/**
 * 扫描并按需清理历史 StreamTask 模型载荷
 * @param {PrismaClient} prisma Prisma 客户端
 * @param {boolean} apply 是否实际写入数据库
 * @returns {Promise<{ scanned: number, matched: number, updated: number }>} 返回扫描、命中和更新数量
 * @description 使用游标分批读取，默认只统计；apply 模式只更新确实含顶层 llm 的记录，操作可重复执行。
 */
async function sanitizeStreamTaskPayloads(prisma, apply) {
  let cursor;
  let scanned = 0;
  let matched = 0;
  let updated = 0;

  while (true) {
    const rows = await prisma.streamTask.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, requestPayload: true },
    });
    if (rows.length === 0) break;

    scanned += rows.length;
    const changes = rows.flatMap((row) => {
      const sanitized = sanitizePayload(row.requestPayload);
      return sanitized.changed && sanitized.payload
        ? [{ id: row.id, payload: sanitized.payload }]
        : [];
    });
    matched += changes.length;

    if (apply && changes.length > 0) {
      await prisma.$transaction(
        changes.map((change) =>
          prisma.streamTask.update({
            where: { id: change.id },
            data: { requestPayload: change.payload },
          }),
        ),
      );
      updated += changes.length;
    }
    cursor = rows[rows.length - 1].id;
  }

  return { scanned, matched, updated };
}

/**
 * 执行命令行清理入口
 * @returns {Promise<void>} 无返回值
 * @description `--apply` 缺省时只输出统计；输出只含数量，不包含任务载荷或模型凭据。
 */
async function main() {
  const apply = process.argv.includes('--apply');
  const unsupported = process.argv.slice(2).filter((arg) => arg !== '--apply');
  if (unsupported.length > 0) {
    throw new Error(`不支持的参数：${unsupported.join(', ')}`);
  }

  const prisma = new PrismaClient();
  try {
    const result = await sanitizeStreamTaskPayloads(prisma, apply);
    console.log(
      apply
        ? `[sanitize] 扫描 ${result.scanned} 条，命中并清理 ${result.updated} 条。`
        : `[sanitize] dry-run：扫描 ${result.scanned} 条，发现 ${result.matched} 条待清理；传入 --apply 才会写入。`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `[sanitize] 执行失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

module.exports = { sanitizePayload, sanitizeStreamTaskPayloads };
