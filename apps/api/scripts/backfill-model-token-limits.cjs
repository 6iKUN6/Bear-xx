#!/usr/bin/env node
/**
 * 按模型模板补齐启用预设的缺失 token 预算。
 * 运行：pnpm --filter ./apps/api exec node scripts/backfill-model-token-limits.cjs
 * 不修改已有数值，不匹配型号别名，不进行数据库迁移。
 */
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
if (!process.env.DATABASE_URL) process.loadEnvFile('.env');
require('ts-node/register/transpile-only');
const { PrismaClient } = require('@prisma/client');
const {
  MODEL_PROVIDER_TEMPLATES,
} = require('../src/modules/llm/model-provider-template.catalog');
const db = new PrismaClient();

/**
 * 补齐并核对模型预算
 * @returns 每个启用模型的处理结果和实际保存值
 * @description 在单个事务内按供应商与模型精确匹配，检测并发变化与预算冲突。
 */
async function backfill() {
  return db.$transaction(async (tx) => {
    const rows = await tx.modelPreset.findMany({
      where: { enabled: true },
      select: {
        id: true,
        presetId: true,
        model: true,
        contextWindowTokens: true,
        maxOutputTokens: true,
        connection: { select: { providerKey: true } },
      },
    });
    const results = [];
    for (const row of rows) {
      const template = MODEL_PROVIDER_TEMPLATES.find(
        (t) => t.providerKey === row.connection.providerKey,
      );
      const model = template?.recommendedModels.find(
        (m) => m.model === row.model,
      );
      if (!model) {
        results.push({
          presetId: row.presetId,
          status: '未匹配模板，保留原值',
        });
        continue;
      }
      const data = {};
      if (
        row.contextWindowTokens === null &&
        model.contextWindowTokens !== null
      )
        data.contextWindowTokens = model.contextWindowTokens;
      if (row.maxOutputTokens === null && model.maxOutputTokens !== null)
        data.maxOutputTokens = model.maxOutputTokens;
      if (Object.keys(data).length) {
        const context = data.contextWindowTokens ?? row.contextWindowTokens;
        const output = data.maxOutputTokens ?? row.maxOutputTokens;
        if (context !== null && output !== null && output >= context)
          throw new Error('预算冲突：' + row.presetId);
        const result = await tx.modelPreset.updateMany({
          where: {
            id: row.id,
            contextWindowTokens: row.contextWindowTokens,
            maxOutputTokens: row.maxOutputTokens,
          },
          data,
        });
        if (result.count !== 1)
          throw new Error('配置已并发变化：' + row.presetId);
      }
      const saved = await tx.modelPreset.findUniqueOrThrow({
        where: { id: row.id },
        select: {
          presetId: true,
          contextWindowTokens: true,
          maxOutputTokens: true,
        },
      });
      results.push({
        ...saved,
        status: Object.keys(data).length ? '已补齐可确认字段' : '保持原值',
      });
    }
    return results;
  });
}

backfill()
  .then((results) => console.log(JSON.stringify(results, null, 2)))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
