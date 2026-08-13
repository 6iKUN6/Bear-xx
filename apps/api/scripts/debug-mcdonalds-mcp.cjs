/*
 * 麦当劳 MCP 只读连通性诊断
 *
 * 目的：验证 token、Streamable HTTP transport 与 tools/list 返回，绝不调用 MCP 工具。
 * 用法：node scripts/debug-mcdonalds-mcp.cjs <MCP_TOKEN>
 */
const fs = require('fs');
const path = require('path');
const { MultiServerMCPClient } = require('@langchain/mcp-adapters');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);
loadDotEnv(path.resolve(backendRoot, '.env'));

const serverName = 'mcdonalds';
const token = process.argv[2];
const url =
  process.env.MCDONALDS_MCP_URL || 'https://mcp.mcd.cn/mcp-servers/mcd-mcp';
const additionalToolNamePrefix = process.env.MCDONALDS_MCP_TOOL_PREFIX || '';

async function main() {
  if (!token) {
    throw new Error('Missing MCP_TOKEN argument');
  }

  const client = new MultiServerMCPClient({
    throwOnLoadError: true,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix,
    useStandardContentBlocks: true,
    onConnectionError: 'throw',
    mcpServers: {
      [serverName]: {
        transport: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
        automaticSSEFallback: true,
        defaultToolTimeout: 30_000,
      },
    },
  });

  try {
    const tools = await client.getTools(serverName);
    console.error(
      JSON.stringify({
        event: 'debug.mcdonalds_mcp.tools_list',
        server: serverName,
        endpoint: safeUrl(url),
        toolCount: tools.length,
        tools: tools.map((item) => item.name),
      }),
    );
  } finally {
    await client.close();
  }
}

function safeUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '[invalid-url]';
  }
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[key] = value;
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: 'debug.mcdonalds_mcp.failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
