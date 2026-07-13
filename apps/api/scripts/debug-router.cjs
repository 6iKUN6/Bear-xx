/*
 * 结构化路由(Kimi)诊断脚本
 * 验证 LLM 决策路由对不同输入返回合理的 mode + 合法 JSON。
 * 用法：node scripts/debug-router.cjs
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

const SYS = [
  '你是一个对话策略路由器。判断用户请求应使用哪种执行策略，只输出 JSON，禁止解释或 Markdown。',
  '可选策略 mode：',
  '- direct：可直接回答，无需工具或多步骤。',
  '- react：需要调用工具（如查询天气）一步到位。',
  '- plan_execute：任务较复杂，需要先拆解为多步骤再依次执行。',
  '- hybrid：任务复杂且需要根据中间结果动态调整，边规划边用工具。',
  '输出格式：{"mode":"direct|react|plan_execute|hybrid","toolGroups":[],"skills":[],"maxSteps":6,"confidence":0.0,"reason":"简述理由"}',
  'toolGroups/skills 只能从"可用能力"中选择；没有合适的就给空数组。',
].join('\n');

const CASES = [
  '你好，你是谁？',
  '深圳今天天气怎么样？',
  '帮我规划一个三天深圳旅行方案，并结合天气给出建议',
  '先查一下深圳天气，再根据结果动态决定这三天每天去哪里玩',
];

async function main() {
  if (!apiKey) throw new Error('Missing KIMI_API_KEY');
  const chat = new ChatOpenAICompletions({
    model,
    apiKey,
    configuration: { baseURL },
  });

  for (const userText of CASES) {
    const user = [
      `用户请求：\n${userText}`,
      '可用工具组：default',
      '可用工具：getWeather',
      '可用技能：（无）',
    ].join('\n\n');
    try {
      const res = await chat.invoke([
        new SystemMessage(SYS),
        new HumanMessage(user),
      ]);
      const raw =
        typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
      const parsed = parseJson(raw);
      console.error(
        JSON.stringify({
          input: userText,
          mode: parsed?.mode,
          toolGroups: parsed?.toolGroups,
          maxSteps: parsed?.maxSteps,
          confidence: parsed?.confidence,
        }),
      );
    } catch (e) {
      console.error(JSON.stringify({ input: userText, error: e.message }));
    }
  }
}

function parseJson(raw) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s < 0 || e <= s) return undefined;
  try {
    return JSON.parse(body.slice(s, e + 1));
  } catch {
    return undefined;
  }
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
  console.error(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
});
