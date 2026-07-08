/*
 * 工具调用往返诊断脚本
 *
 * 目的：复现 ReAct 链路里的两轮工具调用往返，暴露：
 *   1) 代理返回的 tool_call id 形态（fc_* = Responses 语义 / call_* = Chat Completions 语义）
 *   2) 回填工具结果那一轮（turn 2）是否 400 "No tool call found for function call output"
 *
 * 用法：
 *   node scripts/debug-tool-call.cjs                 # 用 OPENAI_MODEL
 *   LLM_DEBUG_MODEL=gpt-4.1 node scripts/debug-tool-call.cjs
 */
const fs = require('fs');
const path = require('path');
const { ChatOpenAICompletions } = require('@langchain/openai');
const { HumanMessage, ToolMessage } = require('@langchain/core/messages');
const { tool } = require('@langchain/core/tools');
const { z } = require('zod');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);
loadDotEnv(path.resolve(backendRoot, '.env'));

const model =
  process.env.LLM_DEBUG_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1';
const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;
const timeoutMs = Number(process.env.LLM_DEBUG_TIMEOUT_MS) || 30000;

const weatherTool = tool(
  async (input) => {
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
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  log('request', { model, baseURL: safeUrl(baseURL), hasApiKey: Boolean(apiKey) });

  const chat = new ChatOpenAICompletions({
    model,
    apiKey,
    temperature: 0.2,
    configuration: { baseURL },
  });
  const bound = chat.bindTools([weatherTool]);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('timeout')), timeoutMs);

  const useStream = process.env.LLM_DEBUG_STREAM === '1';
  log('mode', { streaming: useStream });

  const invokeTurn = async (messages) => {
    if (!useStream) {
      return bound.invoke(messages, { signal: abort.signal });
    }
    const stream = await bound.stream(messages, { signal: abort.signal });
    let acc;
    for await (const chunk of stream) {
      acc = acc ? acc.concat(chunk) : chunk;
    }
    return acc;
  };

  try {
    const userMessage = new HumanMessage('深圳现在的天气怎么样？');

    // ---- Turn 1：期望模型返回一个工具调用 ----
    const ai1 = await invokeTurn([userMessage]);
    const toolCalls = ai1.tool_calls ?? [];
    log('turn1.done', {
      hasToolCalls: toolCalls.length > 0,
      toolCallIds: toolCalls.map((c) => c.id),
      idShape: toolCalls.map((c) => classifyId(c.id)),
      textPreview: readText(ai1.content).slice(0, 80),
    });

    if (toolCalls.length === 0) {
      log('conclusion', {
        result: 'NO_TOOL_CALL',
        note: '模型在 turn1 没有发起工具调用，链路不会进入往返；可能是模型/代理不支持该协议下的工具调用。',
      });
      return;
    }

    // ---- 本地执行工具，构造工具结果消息 ----
    const toolMessages = [];
    for (const call of toolCalls) {
      const output = await weatherTool.invoke(call.args);
      toolMessages.push(
        new ToolMessage({ tool_call_id: call.id, content: String(output) }),
      );
    }

    // ---- Turn 2：回填工具结果，期望模型给出最终回答 ----
    const ai2 = await invokeTurn([userMessage, ai1, ...toolMessages]);
    log('turn2.done', { textPreview: readText(ai2.content).slice(0, 120) });
    log('conclusion', { result: 'ROUND_TRIP_OK' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isCallIdError =
      message.includes('No tool call found') ||
      message.includes('function call output') ||
      message.includes('call_id');
    log('conclusion', {
      result: isCallIdError ? 'ROUND_TRIP_400_CALLID' : 'ERROR',
      error: message,
      note: isCallIdError
        ? '回填工具结果那一轮被拒：代理在 completions↔responses 转换中丢失了 call_id 关联。属于代理/模型协议问题。'
        : undefined,
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
  return `other(${id.slice(0, 6)}…)`;
}

function readText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) =>
      item && typeof item === 'object' && item.type === 'text' ? item.text : '',
    )
    .join('');
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
  console.error(JSON.stringify({ event: `debug.tool.${event}`, ...payload }));
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
