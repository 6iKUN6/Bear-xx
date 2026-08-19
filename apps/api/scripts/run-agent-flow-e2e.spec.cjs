const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const {
  loadLocalE2eEnvironment,
  parseDockerComposePort,
} = require('./run-agent-flow-e2e.cjs');

test('解析 Docker Compose 返回的 IPv4 映射端口', () => {
  assert.deepEqual(parseDockerComposePort('127.0.0.1:49153\n'), {
    host: '127.0.0.1',
    port: '49153',
  });
});

test('解析 Docker Compose 返回的 IPv6 映射端口', () => {
  assert.deepEqual(parseDockerComposePort('[::1]:49153\n'), {
    host: '::1',
    port: '49153',
  });
});

test('拒绝无法识别的 Docker Compose 端口输出', () => {
  assert.throws(
    () => parseDockerComposePort('not-a-port'),
    /无法解析 Docker Compose 端口输出/,
  );
});

test('本地 E2E 环境文件只补充未显式传入的变量', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-flow-e2e-'));
  const environmentFile = join(directory, '.env.agent-flow-e2e');
  writeFileSync(
    environmentFile,
    [
      'TEMPORAL_TEST_SERVER_PATH=/from-file/temporal-test-server',
      'CUSTOM_E2E_VALUE=from-file',
    ].join('\n'),
  );

  try {
    const environment = loadLocalE2eEnvironment(environmentFile, {
      TEMPORAL_TEST_SERVER_PATH: '/from-shell/temporal-test-server',
    });
    assert.equal(
      environment.TEMPORAL_TEST_SERVER_PATH,
      '/from-shell/temporal-test-server',
    );
    assert.equal(environment.CUSTOM_E2E_VALUE, 'from-file');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
