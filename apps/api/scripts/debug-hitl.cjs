/*
 * HITL 机制诊断脚本
 * 直接跑 createAgent + humanInTheLoopMiddleware + checkpointer 的中断/恢复：
 *   1) turn1 触发受审批工具 → 期望在工具执行前中断（getWeather 不执行）
 *   2) getState 读出挂起的 HITLRequest（actionRequests/reviewConfigs）
 *   3) Command({resume:{decisions:[{type:'approve'}]}}) 续跑 → 工具执行 + 最终答案
 * 用法：node scripts/debug-hitl.cjs
 */
const fs = require('fs');
const path = require('path');
const { createAgent, humanInTheLoopMiddleware } = require('langchain');
const { MemorySaver, Command } = require('@langchain/langgraph');
const { ChatOpenAICompletions } = require('@langchain/openai');
const { tool } = require('@langchain/core/tools');
const { z } = require('zod');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);
loadDotEnv(path.resolve(backendRoot, '.env'));

const model = process.env.OPENAI_MODEL || 'gpt-4.1';
const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;

let toolExecuted = false;
const weatherTool = tool(
  async (input) => {
    toolExecuted = true;
    console.log('[tool executed] getWeather', input);
    return `天气查询结果：${input.city}，晴，28°C`;
  },
  {
    name: 'getWeather',
    description: '根据城市名称查询当前天气',
    schema: z.object({ city: z.string() }),
  },
);

async function drain(stream) {
  for await (const _ of stream) {
    void _;
  }
}

async function main() {
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  const chat = new ChatOpenAICompletions({
    model,
    apiKey,
    configuration: { baseURL },
  });

  const agent = createAgent({
    model: chat,
    tools: [weatherTool],
    middleware: [
      humanInTheLoopMiddleware({
        interruptOn: {
          getWeather: {
            allowedDecisions: ['approve', 'edit', 'reject'],
            description: '请确认是否执行工具「getWeather」',
          },
        },
      }),
    ],
    checkpointer: new MemorySaver(),
    name: 'debug-hitl',
  });

  const config = {
    streamMode: 'messages',
    configurable: { thread_id: 'debug-thread-1' },
  };

  // ---- turn1：期望中断 ----
  await drain(
    await agent.stream(
      { messages: [{ role: 'user', content: '深圳现在的天气怎么样？' }] },
      config,
    ),
  );
  log('turn1', { toolExecutedAfterTurn1: toolExecuted });

  // ---- getState 读挂起中断 ----
  const state = await agent.getState({
    configurable: { thread_id: 'debug-thread-1' },
  });
  const interrupts = (state.tasks || []).flatMap((t) => t.interrupts || []);
  const value = interrupts[0] && interrupts[0].value;
  log('interrupt', {
    paused: interrupts.length > 0,
    next: state.next,
    actionRequests: value && value.actionRequests,
    reviewConfigs: value && value.reviewConfigs,
  });

  if (interrupts.length === 0) {
    log('conclusion', { result: 'NO_INTERRUPT（中断未触发，检查中间件/checkpointer）' });
    return;
  }

  // ---- resume：approve 续跑 ----
  await drain(
    await agent.stream(
      new Command({ resume: { decisions: [{ type: 'approve' }] } }),
      config,
    ),
  );
  log('resume', { toolExecutedAfterResume: toolExecuted });

  const finalState = await agent.getState({
    configurable: { thread_id: 'debug-thread-1' },
  });
  const messages = finalState.values && finalState.values.messages;
  const lastAi =
    Array.isArray(messages) &&
    [...messages].reverse().find((m) => m.getType && m.getType() === 'ai');
  const text =
    lastAi && (typeof lastAi.content === 'string' ? lastAi.content : '');
  log('conclusion', {
    result: toolExecuted ? 'HITL_OK' : 'TOOL_NOT_EXECUTED_AFTER_APPROVE',
    finalAnswerPreview: (text || '').slice(0, 120),
  });
}

function log(event, payload) {
  console.error(JSON.stringify({ event: `debug.hitl.${event}`, ...payload }));
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
  log('failed', { error: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
});
