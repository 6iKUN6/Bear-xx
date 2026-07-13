/*
 * createAgent 路径复现脚本
 *
 * 目的：严格照搬 app 的执行路径（common-chat-agent.factory + common-chat-agent-loop.service），
 * 用 createAgent + streamEvents({version:'v3'}) 消费 run.messages / run.toolCalls / run.output，
 * 看是否复现：tool_call id 为 fc_*、回填工具结果 400、或工具体不执行（console.log 不打印）。
 *
 * 用法：
 *   node scripts/debug-agent.cjs
 *   LLM_DEBUG_MODEL=gpt-5.5 node scripts/debug-agent.cjs
 */
const fs = require('fs');
const path = require('path');
const { createAgent } = require('langchain');
const { ChatOpenAICompletions } = require('@langchain/openai');
const { tool } = require('@langchain/core/tools');
const { z } = require('zod');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);
loadDotEnv(path.resolve(backendRoot, '.env'));

const model =
  process.env.LLM_DEBUG_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1';
const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;
const timeoutMs = Number(process.env.LLM_DEBUG_TIMEOUT_MS) || 40000;

let toolExecuted = false;
const weatherTool = tool(
  async (input) => {
    toolExecuted = true;
    console.log('[tool executed] getWeather input =', input);
    return `天气查询结果：${input.city}，晴，28°C`;
  },
  {
    name: 'getWeather',
    description: '根据城市名称查询当前天气',
    schema: z.object({ city: z.string().describe('城市名称') }),
  },
);

async function main() {
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  log('request', { model, baseURL: safeUrl(baseURL) });

  const chat = new ChatOpenAICompletions({
    model,
    apiKey,
    temperature: 0.2,
    configuration: { baseURL },
  });

  // 照搬 factory：createAgent 收敛模型 + 工具 + systemPrompt
  const agent = createAgent({
    model: chat,
    systemPrompt: '你是一个有用的助手，需要天气信息时调用 getWeather 工具。',
    tools: [weatherTool],
    middleware: [],
    name: 'common-chat-agent',
  });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('timeout')), timeoutMs);

  try {
    // 对照实验：createAgent + invoke（非 v3 流式）
    if (process.env.LLM_DEBUG_INVOKE === '1') {
      const res = await agent.invoke(
        { messages: [{ role: 'user', content: '深圳现在的天气怎么样？' }] },
        { signal: abort.signal, configurable: {} },
      );
      const msgs = res.messages || [];
      const aiToolCalls = msgs.flatMap((m) => m.tool_calls || []);
      log('invoke.done', {
        toolExecuted,
        messageCount: msgs.length,
        toolCallIds: aiToolCalls.map((c) => c.id),
        idShapes: aiToolCalls.map((c) => classifyId(c.id)),
      });
      log('conclusion', {
        result: toolExecuted ? 'AGENT_INVOKE_OK' : 'TOOL_NOT_EXECUTED',
      });
      clearTimeout(timer);
      return;
    }

    // 对照实验：createAgent + stream(streamMode:'messages')（保留流式，但不走 v3 投影）
    if (process.env.LLM_DEBUG_STREAM_MODE === '1') {
      const stream = await agent.stream(
        { messages: [{ role: 'user', content: '深圳现在的天气怎么样？' }] },
        { streamMode: 'messages', signal: abort.signal, configurable: {} },
      );
      // 复刻 loop service 的事件映射，验证翻译正确性
      const events = [];
      const readText = (c) =>
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c
                .map((x) =>
                  x && x.type === 'text' && typeof x.text === 'string'
                    ? x.text
                    : '',
                )
                .join('')
            : '';
      const toolIndexById = new Map();
      const toolNameById = new Map();
      let nextToolIndex = 0;
      let lastToolCallId;
      let textAcc = '';
      for await (const part of stream) {
        const msg = Array.isArray(part) ? part[0] : part;
        const type = typeof msg?.getType === 'function' ? msg.getType() : '';
        if (type === 'tool') {
          const id = msg.tool_call_id;
          events.push(msg.status === 'error' ? 'ToolCallError' : 'ToolCallDone');
          continue;
        }
        if (type !== 'ai') continue;
        const t = readText(msg.content);
        if (t) {
          textAcc += t;
          events.push('MessageDelta');
        }
        for (const c of msg.tool_call_chunks ?? []) {
          const id = (typeof c.id === 'string' && c.id) || lastToolCallId;
          if (!id) continue;
          lastToolCallId = id;
          if (c.name && !toolNameById.has(id)) toolNameById.set(id, c.name);
          if (!toolIndexById.has(id)) {
            toolIndexById.set(id, nextToolIndex++);
            events.push(`ToolCallStart(${toolNameById.get(id)})`);
          }
          events.push('ToolCallDelta');
        }
      }
      // 压缩连续重复事件，便于阅读
      const compact = events.filter((e, i) => e !== events[i - 1] || !e.includes('Delta'));
      log('mapped.events', { sequence: compact });
      log('final.text', { text: textAcc.slice(0, 120) });
      log('stream.done', { toolExecuted });
      log('conclusion', {
        result: toolExecuted ? 'AGENT_STREAM_OK' : 'TOOL_NOT_EXECUTED',
      });
      clearTimeout(timer);
      return;
    }

    // 照搬 loop service：streamEvents v3 + 三路并发消费
    const run = await agent.streamEvents(
      { messages: [{ role: 'user', content: '深圳现在的天气怎么样？' }] },
      { version: 'v3', signal: abort.signal, configurable: {} },
    );

    const seenToolCallIds = [];
    let textOut = '';

    const consumeMessages = (async () => {
      for await (const message of run.messages) {
        for await (const delta of message.text) {
          if (delta) textOut += delta;
        }
      }
    })();

    const consumeToolCalls = (async () => {
      for await (const call of run.toolCalls) {
        seenToolCallIds.push({ id: call.callId, name: call.name });
        log('toolCall.seen', {
          name: call.name,
          callId: call.callId,
          idShape: classifyId(call.callId),
        });
      }
    })();

    await Promise.all([consumeMessages, consumeToolCalls, run.output]);

    log('done', {
      toolExecuted,
      toolCalls: seenToolCallIds,
      idShapes: seenToolCallIds.map((c) => classifyId(c.id)),
      textPreview: textOut.slice(0, 120),
    });
    log('conclusion', {
      result: toolExecuted ? 'AGENT_ROUND_TRIP_OK' : 'TOOL_NOT_EXECUTED',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isCallIdError =
      message.includes('No tool call found') ||
      message.includes('function call output') ||
      message.includes('call_id');
    log('conclusion', {
      result: isCallIdError ? 'AGENT_400_CALLID' : 'AGENT_ERROR',
      toolExecuted,
      error: message,
    });
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

function classifyId(id) {
  if (typeof id !== 'string') return 'none';
  if (id.startsWith('fc_')) return 'fc_ (Responses 语义)';
  if (id.startsWith('call_')) return 'call_ (Chat Completions 语义)';
  return `other(${String(id).slice(0, 6)}…)`;
}

function safeUrl(value) {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return '[invalid-url]';
  }
}

function log(event, payload) {
  console.error(JSON.stringify({ event: `debug.agent.${event}`, ...payload }));
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 0) continue;
    const key = trimmed.slice(0, i).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(i + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[key] = value;
  }
}

main().catch((error) => {
  log('failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
