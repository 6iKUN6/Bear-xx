const fs = require('fs');
const path = require('path');
const { ChatAnthropic } = require('@langchain/anthropic');
const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage } = require('@langchain/core/messages');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);

loadDotEnv(path.resolve(backendRoot, '.env'));

const prompt =
  process.argv.slice(2).join(' ').trim() ||
  process.env.LLM_DEBUG_PROMPT ||
  '你好，请用一句话介绍你自己。';
const provider = process.env.LLM_DEBUG_PROVIDER || 'openai';
const timeoutMs = Number(process.env.LLM_DEBUG_TIMEOUT_MS) || 30000;

async function main() {
  const modelConfig = resolveModelConfig(provider);

  if (!modelConfig.apiKey) {
    throw new Error(modelConfig.missingApiKeyMessage);
  }

  console.error(
    JSON.stringify({
      event: 'debug.llm.request',
      provider: modelConfig.provider,
      model: modelConfig.model,
      baseURL: toSafeBaseUrl(modelConfig.baseURL),
      hasApiKey: Boolean(modelConfig.apiKey),
      promptLength: prompt.length,
      timeoutMs,
    }),
  );

  const chatModel = createChatModel(modelConfig);

  const startedAt = Date.now();
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new Error(`LLM debug request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  let rawChunkCount = 0;
  let parsedChunkCount = 0;
  let skippedChunkCount = 0;
  let fullContent = '';

  try {
    const stream = await chatModel.stream([new HumanMessage(prompt)], {
      signal: abortController.signal,
    });

    for await (const chunk of stream) {
      rawChunkCount++;
      const delta = readChunkText(chunk.content);

      console.error(
        JSON.stringify({
          event: 'debug.llm.chunk',
          chunkIndex: rawChunkCount,
          contentType: describeChunkContent(chunk.content),
          parsedTextLength: delta.length,
        }),
      );

      if (!delta) {
        skippedChunkCount++;
        continue;
      }

      parsedChunkCount++;
      fullContent += delta;
      process.stdout.write(delta);
    }

    if (fullContent) {
      process.stdout.write('\n');
    }

    console.error(
      JSON.stringify({
        event: 'debug.llm.completed',
        rawChunkCount,
        parsedChunkCount,
        skippedChunkCount,
        fullContentLength: fullContent.length,
        durationMs: Date.now() - startedAt,
      }),
    );

    if (!fullContent.trim()) {
      process.exitCode = 2;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = parseDotEnvValue(rawValue);
  }
}

function parseDotEnvValue(value) {
  const quote = value[0];
  if (
    (quote === '"' || quote === "'") &&
    value.length > 1 &&
    value[value.length - 1] === quote
  ) {
    return value.slice(1, -1);
  }

  return value.replace(/\s+#.*$/, '').trim();
}

function resolveModelConfig(rawProvider) {
  const normalizedProvider = rawProvider.trim().toLowerCase();

  if (normalizedProvider === 'anthropic') {
    return {
      provider: 'anthropic',
      model:
        process.env.LLM_DEBUG_MODEL ||
        process.env.ANTHROPIC_MODEL ||
        process.env.LLM_MODEL ||
        'claude-sonnet-4-5-20250929',
      apiKey: process.env.LLM_DEBUG_API_KEY || process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.LLM_DEBUG_BASE_URL || process.env.ANTHROPIC_BASE_URL,
      missingApiKeyMessage:
        'Missing ANTHROPIC_API_KEY or LLM_DEBUG_API_KEY',
    };
  }

  if (normalizedProvider !== 'openai') {
    throw new Error(
      `Unsupported LLM_DEBUG_PROVIDER: ${rawProvider}. Expected openai or anthropic.`,
    );
  }

  return {
    provider: 'openai',
    model:
      process.env.LLM_DEBUG_MODEL ||
      process.env.OPENAI_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini',
    apiKey: process.env.LLM_DEBUG_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.LLM_DEBUG_BASE_URL || process.env.OPENAI_BASE_URL,
    missingApiKeyMessage: 'Missing OPENAI_API_KEY or LLM_DEBUG_API_KEY',
  };
}

function createChatModel(config) {
  const temperature = Number(process.env.LLM_DEBUG_TEMPERATURE) || 0.2;
  const maxTokens = Number(process.env.LLM_DEBUG_MAX_TOKENS) || 512;

  if (config.provider === 'anthropic') {
    return new ChatAnthropic({
      model: config.model,
      apiKey: config.apiKey,
      anthropicApiUrl: config.baseURL,
      temperature,
      maxTokens,
    });
  }

  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    temperature,
    maxTokens,
    configuration: {
      baseURL: config.baseURL,
    },
  });
}

function readChunkText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const text = item.text;
      return item.type === 'text' && typeof text === 'string' ? text : '';
    })
    .join('');
}

function describeChunkContent(content) {
  if (typeof content === 'string') {
    return { type: 'string', length: content.length };
  }

  if (Array.isArray(content)) {
    return {
      type: 'array',
      length: content.length,
      blockTypes: content.map((item) =>
        item && typeof item === 'object'
          ? String(item.type ?? 'unknown')
          : typeof item,
      ),
    };
  }

  return { type: typeof content };
}

function toSafeBaseUrl(value) {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).origin;
  } catch {
    return '[invalid-url]';
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: 'debug.llm.failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
