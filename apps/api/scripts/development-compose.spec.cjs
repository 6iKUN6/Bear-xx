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
 * @param extraArgs 追加在 config 之前的全局参数，例如 `--profile debug`
 * @returns 返回 Docker Compose 解析后的服务配置对象
 * @description 通过 JSON 结构断言服务依赖，避免测试依赖 YAML 展开文本的缩进格式。
 */
function readDevelopmentComposeJson(extraArgs = []) {
  return JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--file',
        composeFile,
        ...extraArgs,
        'config',
        '--format',
        'json',
      ],
      {
        cwd: apiRoot,
        encoding: 'utf8',
      },
    ),
  );
}

test('开发 Compose 内嵌 Worker、共用主 Postgres，Temporal UI 按需启动', () => {
  const services = readDevelopmentComposeJson().services;

  assert.deepEqual(
    Object.keys(services).sort(),
    ['app', 'db', 'redis', 'temporal', 'workspace-bootstrap'],
    '默认只应启动 app / db / redis / temporal 与一次性 bootstrap',
  );
  assert.equal(
    services.app.environment.TEMPORAL_EMBEDDED_WORKERS,
    'true',
    'app 必须内嵌运行 Temporal Worker',
  );
  assert.equal(services.app.environment.TEMPORAL_ADDRESS, 'temporal:7233');
  assert.equal(
    services.temporal.environment.POSTGRES_SEEDS,
    'db',
    'Temporal 必须使用主 Postgres，而不是独立数据库容器',
  );
  assert.equal(
    services.temporal.depends_on.db.condition,
    'service_healthy',
  );
  for (const name of ['app', 'db', 'redis', 'temporal']) {
    assert.ok(services[name].mem_limit, `${name} 必须设置 mem_limit`);
  }

  const debugServices = readDevelopmentComposeJson(['--profile', 'debug'])
    .services;
  assert.ok(debugServices['temporal-ui'], 'debug profile 应包含 Temporal UI');
  assert.equal(debugServices['temporal-ui'].ports[0].published, '8233');
});

test('开发 Compose 在工作区 bootstrap 成功后启动 API', () => {
  const config = readDevelopmentComposeConfig();
  const structuredConfig = readDevelopmentComposeJson();
  const source = readDevelopmentComposeSource();

  assert.ok(
    /^  workspace-bootstrap:$/m.test(config),
    '开发 Compose 缺少 workspace-bootstrap 服务',
  );
  for (const serviceName of ['app']) {
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
