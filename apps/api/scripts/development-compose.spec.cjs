const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const apiRoot = resolve(__dirname, '..');
const composeFile = resolve(apiRoot, 'docker-compose.yml');

/**
 * 读取展开后的开发 Docker Compose 配置
 * @returns 返回 Docker Compose 生成的完整 YAML 文本
 * @description 通过 Docker Compose 自身解析 YAML，避免测试仅依赖字符串匹配而遗漏 Compose 语法错误或依赖关系被错误展开的问题。
 */
function readDevelopmentComposeConfig() {
  return execFileSync(
    'docker',
    ['compose', '--file', composeFile, 'config'],
    {
      cwd: apiRoot,
      encoding: 'utf8',
    },
  );
}

/**
 * 读取开发 Docker Compose 源配置
 * @returns 返回 docker-compose.yml 原始文本
 * @description 校验构建上下文等无法稳定从展开配置中断言的工作区布局约束。
 */
function readDevelopmentComposeSource() {
  return readFileSync(composeFile, 'utf8');
}

/**
 * 读取结构化的开发 Docker Compose 配置
 * @returns 返回 Docker Compose 解析后的服务配置对象
 * @description 通过 JSON 结构断言服务依赖，避免测试依赖 YAML 展开文本的缩进格式。
 */
function readDevelopmentComposeJson() {
  return JSON.parse(
    execFileSync(
      'docker',
      ['compose', '--file', composeFile, 'config', '--format', 'json'],
      {
        cwd: apiRoot,
        encoding: 'utf8',
      },
    ),
  );
}

test('开发 Compose 包含独立 Temporal 持久化、服务、UI 与双 Worker', () => {
  const config = readDevelopmentComposeConfig();

  for (const serviceName of [
    'temporal-db',
    'temporal',
    'temporal-ui',
    'temporal-orchestrator-worker',
    'temporal-activity-worker',
  ]) {
    assert.ok(
      new RegExp(`^  ${serviceName}:$`, 'm').test(config),
      `开发 Compose 缺少 ${serviceName} 服务`,
    );
  }

  assert.ok(
    /TEMPORAL_ADDRESS: temporal:7233/.test(config),
    '开发 Compose 未将应用连接到 Temporal Server',
  );
  assert.ok(
    /TEMPORAL_WORKER_ROLE: orchestrator/.test(config),
    '开发 Compose 未配置编排 Worker 角色',
  );
  assert.ok(
    /TEMPORAL_WORKER_ROLE: activity/.test(config),
    '开发 Compose 未配置 Activity Worker 角色',
  );
  assert.ok(
    /published: "8233"/.test(config),
    '开发 Compose 未暴露 Temporal UI 端口',
  );
});

test('开发 Compose 在工作区 bootstrap 成功后启动 API 与双 Worker', () => {
  const config = readDevelopmentComposeConfig();
  const structuredConfig = readDevelopmentComposeJson();
  const source = readDevelopmentComposeSource();

  assert.ok(
    /^  workspace-bootstrap:$/m.test(config),
    '开发 Compose 缺少 workspace-bootstrap 服务',
  );
  for (const serviceName of [
    'app',
    'temporal-orchestrator-worker',
    'temporal-activity-worker',
  ]) {
    assert.equal(
      structuredConfig.services[serviceName].depends_on['workspace-bootstrap']
        .condition,
      'service_completed_successfully',
      `${serviceName} 必须等待 workspace-bootstrap 成功完成`,
    );
    assert.equal(
      structuredConfig.services[serviceName].depends_on.temporal.condition,
      'service_healthy',
      `${serviceName} 必须等待 Temporal 健康后启动`,
    );
  }
  assert.match(source, /context: \.\.\/\.\./);
  assert.match(source, /dockerfile: apps\/api\/Dockerfile/);
  assert.match(source, /pnpm --filter \.\/packages\/types run build/);
  assert.match(source, /pnpm --filter \.\/apps\/api run db:migrate:deploy/);
  assert.match(source, /condition: service_healthy/);
});
