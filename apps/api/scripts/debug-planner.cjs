/*
 * Planner(Kimi)诊断脚本
 * 验证 Kimi 预设可连通，且能对规划提示词返回可解析的步骤 JSON。
 * 用法：node scripts/debug-planner.cjs "帮我规划一个三天深圳旅行方案"
 */
const fs = require('fs');
const path = require('path');
const { ChatOpenAICompletions } = require('@langchain/openai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);
loadDotEnv(path.resolve(backendRoot, '.env'));

const model = process.env.KIMI_MODEL || 'kimi-k2-0711-preview';
const apiKey = process.env.KIMI_API_KEY;
const baseURL = process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1';
const userText =
  process.argv.slice(2).join(' ').trim() || '帮我规划一个三天深圳旅行方案，并查一下深圳天气';

async function main() {
  if (!apiKey) throw new Error('Missing KIMI_API_KEY');
  console.error(JSON.stringify({ event: 'planner.request', model, baseURL }));

  const chat = new ChatOpenAICompletions({
    model,
    apiKey,
    // kimi-for-coding 仅允许 temperature=1，故不覆盖，走模型默认
    configuration: { baseURL },
  });

  const sys =
    '你是任务规划助手。把用户请求拆解为有序、可执行的步骤。最多输出 5 个步骤。只输出 JSON：{"steps":[{"goal":"步骤目标"}]}';
  const res = await chat.invoke([
    new SystemMessage(sys),
    new HumanMessage(`用户请求：\n${userText}\n\n可用工具：getWeather`),
  ]);

  const raw = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
  console.error(JSON.stringify({ event: 'planner.raw', raw: raw.slice(0, 400) }));

  const steps = parseSteps(raw);
  console.error(
    JSON.stringify({
      event: 'planner.parsed',
      ok: steps.length > 0,
      stepCount: steps.length,
      steps,
    }),
  );
}

function parseSteps(raw) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = Math.min(
    ...[body.indexOf('{'), body.indexOf('[')].filter((i) => i >= 0),
  );
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (!(end > start)) return [];
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : parsed?.steps;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => (typeof x === 'string' ? x : x?.goal))
    .filter((g) => typeof g === 'string' && g.trim());
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (!k || process.env[k] !== undefined) continue;
    let v = t.slice(i + 1).trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    process.env[k] = v;
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ event: 'planner.failed', error: e.message }));
  process.exitCode = 1;
});
