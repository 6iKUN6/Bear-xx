/*
 * 联网搜索工具真实往返诊断脚本
 *
 * 目的：加载真实的 webSearch 工具，用配置的 TAVILY_API_KEY 打一次真实搜索，
 * 验证 key 有效、Tavily 通路正常、返回结果能被格式化成中文摘要。
 *
 * 用法：
 *   node scripts/debug-web-search.cjs
 *   node scripts/debug-web-search.cjs "自定义查询词"
 */
const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);
loadDotEnv(path.resolve(backendRoot, '.env'));

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    target: 'es2021',
    esModuleInterop: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
  },
});

const webSearch = require('../src/modules/ai/tools/webSearch').default;

async function main() {
  const query = process.argv[2] || '2026 年最新的 AI 新闻';
  log('request', {
    query,
    hasApiKey: Boolean(process.env.TAVILY_API_KEY),
    toolName: webSearch.name,
  });

  const start = Date.now();
  const output = await webSearch.invoke({ query, maxResults: 3 });
  const elapsedMs = Date.now() - start;

  console.log('\n===== 工具返回内容 =====\n');
  console.log(output);
  console.log('\n========================\n');

  const failed =
    typeof output === 'string' &&
    (output.startsWith('联网搜索不可用') ||
      output.startsWith('联网搜索失败') ||
      output.startsWith('未搜索到'));

  log('conclusion', {
    result: failed ? 'SEARCH_FAILED_OR_EMPTY' : 'SEARCH_OK',
    elapsedMs,
    outputLength: typeof output === 'string' ? output.length : 0,
  });
  process.exitCode = failed ? 1 : 0;
}

function log(event, payload) {
  console.error(JSON.stringify({ event: `debug.web-search.${event}`, ...payload }));
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
