#!/usr/bin/env node
/**
 * 把 .env 里的各厂商模型配置一次性导入数据库
 * @description 模型配置改为「后台数据库唯一源」后，原先散落在 OPENAI_* / ANTHROPIC_* /
 * DEEPSEEK_* / KIMI_* / DOUBAO_* 里的 key 需要搬进 model_presets 表并加密。跑完这个脚本后，
 * 应当把这些键从 .env、.env.example 与 docker-compose 中删除，只保留
 * LLM_CREDENTIAL_ENCRYPTION_KEY —— 否则残留的 env 会让人误以为它们仍然生效。
 *
 * 用法：
 *   node apps/api/scripts/import-model-presets-from-env.cjs [--dry-run]
 *
 * 幂等：按 presetId 判断，已存在则跳过（不覆盖后台已做的修改）。
 */
const path = require('node:path');
const crypto = require('node:crypto');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
});

const { PrismaClient } = require('@prisma/client');

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** 各厂商 env → 预设定义；与 registry 删除前的 loadEnvironmentModelPresets 一一对应 */
const SOURCES = [
  {
    platform: 'openai',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini',
    upstreamFormat: 'OPENAI_CHAT_COMPLETIONS',
  },
  {
    platform: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-sonnet-4-5',
    upstreamFormat: 'ANTHROPIC_MESSAGES',
  },
  {
    platform: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    upstreamFormat: 'OPENAI_CHAT_COMPLETIONS',
  },
  {
    platform: 'kimi',
    apiKeyEnv: 'KIMI_API_KEY',
    baseUrlEnv: 'KIMI_BASE_URL',
    modelEnv: 'KIMI_MODEL',
    defaultModel: 'kimi-k2-0905-preview',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    upstreamFormat: 'OPENAI_CHAT_COMPLETIONS',
  },
  {
    platform: 'doubao',
    apiKeyEnv: 'DOUBAO_API_KEY',
    baseUrlEnv: 'DOUBAO_BASE_URL',
    modelEnv: 'DOUBAO_MODEL',
    defaultModel: 'doubao-seed-1-6-250615',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    upstreamFormat: 'OPENAI_CHAT_COMPLETIONS',
  },
];

/**
 * 读取并校验加密主密钥
 * @returns 返回 32 字节密钥
 */
function requireKey() {
  const encoded = (process.env.LLM_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
  if (!key || key.length !== 32) {
    throw new Error(
      'LLM_CREDENTIAL_ENCRYPTION_KEY 必须是 base64 编码的 32 字节密钥。\n' +
        "生成：node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

/**
 * 加密 apiKey
 * @param apiKey 明文
 * @param key 主密钥
 * @returns 返回版本化密文
 * @description 必须与 LlmCredentialCryptoService.encrypt 的格式完全一致，否则服务端解不开。
 */
function encrypt(apiKey, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([
    cipher.update(apiKey, 'utf8'),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** 读取非空 env */
function readEnv(name) {
  const value = (process.env[name] || '').trim();
  return value || undefined;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const key = requireKey();
  const prisma = new PrismaClient();
  const defaultModelId = readEnv('LLM_DEFAULT_MODEL_ID');

  try {
    const planned = [];
    for (const source of SOURCES) {
      const apiKey = readEnv(source.apiKeyEnv);
      if (!apiKey) {
        continue;
      }
      const model = readEnv(source.modelEnv) || source.defaultModel;
      const presetId = `${source.platform}:${model}`;
      planned.push({
        presetId,
        name: `${source.platform} ${model}`,
        description: `由 ${source.apiKeyEnv} 自动导入`,
        platform: source.platform,
        model,
        upstreamFormat: source.upstreamFormat,
        baseURL: readEnv(source.baseUrlEnv) || source.defaultBaseUrl || null,
        apiKeyCiphertext: encrypt(apiKey, key),
        apiKeyFingerprint: crypto
          .createHash('sha256')
          .update(apiKey, 'utf8')
          .digest('hex'),
        // 一律标记为未探测：导入只搬运配置，不能替上游担保它现在还通
        capability: 'UNVERIFIED',
        isDefault: defaultModelId
          ? presetId === defaultModelId
          : planned.length === 0,
      });
    }

    if (planned.length === 0) {
      console.log('未在 .env 中发现任何厂商 apiKey，无需导入。');
      return;
    }

    for (const preset of planned) {
      const exists = await prisma.modelPreset.findUnique({
        where: { presetId: preset.presetId },
      });
      if (exists) {
        console.log(`跳过（已存在）：${preset.presetId}`);
        continue;
      }
      if (dryRun) {
        console.log(
          `将创建：${preset.presetId}  format=${preset.upstreamFormat}  baseURL=${preset.baseURL || '(SDK 默认)'}  default=${preset.isDefault}`,
        );
        continue;
      }
      await prisma.modelPreset.create({ data: preset });
      console.log(`已导入：${preset.presetId}`);
    }

    if (!dryRun) {
      console.log(
        '\n导入完成。接下来：\n' +
          '  1. 在后台逐个点「测试连接」，探测结果会写入 capability\n' +
          '  2. 从 .env / .env.example / docker-compose 删除 OPENAI_API_KEY 等键\n' +
          '     （只保留 LLM_CREDENTIAL_ENCRYPTION_KEY）',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
