const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const apiRoot = resolve(__dirname, '..');
const workspaceRoot = resolve(apiRoot, '..', '..');

/**
 * 读取 API Dockerfile 内容
 * @returns 返回 Dockerfile 原始文本
 * @description 将容器构建的网络韧性约束固定为可执行测试，避免后续修改重新引入每次构建全量下载依赖的问题。
 */
function readDockerfile() {
  return readFileSync(resolve(apiRoot, 'Dockerfile'), 'utf8');
}

/**
 * 读取工作区 Docker 构建忽略规则
 * @returns 返回 .dockerignore 原始文本
 * @description 构建上下文提升到仓库根后，确保本地密钥、依赖目录和构建产物不会被发送给 Docker daemon 或写入镜像层。
 */
function readDockerignore() {
  return readFileSync(resolve(workspaceRoot, '.dockerignore'), 'utf8');
}

test('Dockerfile 支持可覆盖 Registry 并缓存 pnpm store', () => {
  const dockerfile = readDockerfile();

  assert.match(dockerfile, /ARG PNPM_REGISTRY=/);
  assert.match(dockerfile, /--mount=type=cache,id=pnpm-store/);
  assert.match(dockerfile, /--store-dir=\/pnpm\/store/);
  assert.match(dockerfile, /--registry="\$\{PNPM_REGISTRY\}"/);
  assert.match(dockerfile, /--network-concurrency=4/);
  assert.doesNotMatch(dockerfile, /pnpm config set .*--global/);
});

test('Dockerfile 以根 workspace 安装 API 及其共享依赖', () => {
  const dockerfile = readDockerfile();

  assert.match(dockerfile, /ARG NODE_IMAGE=node:24-bookworm-slim/);
  assert.match(dockerfile, /corepack prepare pnpm@10\.27\.0 --activate/);
  assert.match(dockerfile, /ENV HUSKY=0/);
  assert.match(
    dockerfile,
    /COPY pnpm-workspace\.yaml pnpm-lock\.yaml package\.json \.\//,
  );

  for (const importerPath of [
    'apps/admin/package.json apps/admin/',
    'apps/api/package.json apps/api/',
    'apps/mobile/package.json apps/mobile/',
    'packages/assets/package.json packages/assets/',
    'packages/theme/package.json packages/theme/',
    'packages/types/package.json packages/types/',
  ]) {
    assert.ok(
      dockerfile.includes(`COPY ${importerPath}`),
      `Dockerfile 必须复制 ${importerPath} 参与 workspace 锁文件校验`,
    );
  }

  assert.match(dockerfile, /--filter "\.\/apps\/api\.\.\."/);
  assert.match(
    dockerfile,
    /pnpm --filter \.\/apps\/api exec prisma generate/,
  );
});

test('Docker 根构建上下文排除本地密钥、依赖和构建产物', () => {
  const dockerignore = readDockerignore();

  for (const ignoredPath of [
    '**/node_modules',
    '**/dist',
    '**/.env',
    '**/.env.*',
  ]) {
    assert.ok(
      dockerignore.split(/\r?\n/).includes(ignoredPath),
      `.dockerignore 必须排除 ${ignoredPath}`,
    );
  }

  assert.ok(
    dockerignore.split(/\r?\n/).includes('!apps/api/.env.agent-flow-e2e.example'),
    '.dockerignore 必须保留可提交的 AgentFlow E2E 环境变量示例',
  );
});
