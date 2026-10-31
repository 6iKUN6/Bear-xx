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
 * @description 不读取私密 env_file；通过 Docker Compose 自身解析 YAML，避免测试仅依赖字符串匹配而遗漏 Compose 语法错误或依赖关系被错误展开的问题。
 */
function readDevelopmentComposeConfig() {
  return execFileSync(
    'docker',
    ['compose', '--file', composeFile, 'config', '--no-env-resolution'],
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
 * 按 `FROM` 把 Dockerfile 拆成阶段
 * @returns 返回「阶段名 → 该阶段正文」的映射
 * @description 断言必须落在具体阶段上：整份文件里出现 chromium 不能证明 API 镜像没装它，
 * 反过来，紧邻下一个 FROM 的说明性注释也不能算进上一阶段。
 */
function readDockerfileStages() {
  const stages = new Map();
  let currentName;
  let buffer = [];
  const flush = () => {
    if (currentName) {
      stages.set(
        currentName,
        buffer.filter((line) => !line.trim().startsWith('#')).join('\n'),
      );
    }
    buffer = [];
  };
  for (const line of readFileSync(resolve(apiRoot, 'Dockerfile'), 'utf8').split(
    /\r?\n/,
  )) {
    const match = /^FROM\s+\S+\s+AS\s+(\S+)/i.exec(line.trim());
    if (match) {
      flush();
      currentName = match[1];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return stages;
}

/**
 * 读取结构化的开发 Docker Compose 配置
 * @param extraArgs 追加在 config 之前的全局参数，例如 `--profile debug`
 * @returns 返回 Docker Compose 解析后的服务配置对象
 * @description 不读取私密 env_file；通过 JSON 结构断言服务依赖，避免测试依赖 YAML 展开文本的缩进格式。
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
        '--no-env-resolution',
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

test('开发 Compose 用独立 Worker 进程、共用主 Postgres，Temporal UI 按需启动', () => {
  const services = readDevelopmentComposeJson().services;

  assert.deepEqual(
    Object.keys(services).sort(),
    [
      'app',
      'db',
      'redis',
      'temporal',
      'worker-activity',
      'worker-orchestrator',
      'workspace-bootstrap',
    ],
    '默认应启动 app、两个独立 Worker、db、redis、temporal 与一次性 bootstrap',
  );
  assert.equal(
    services.app.environment.TEMPORAL_EMBEDDED_WORKERS,
    'false',
    'API 进程不得内嵌 Temporal Worker',
  );
  assert.equal(services.app.environment.TEMPORAL_ADDRESS, 'temporal:7233');
  assert.equal(
    services['worker-orchestrator'].environment.TEMPORAL_WORKER_ROLE,
    'orchestrator',
    '编排 Worker 必须显式声明 orchestrator 角色',
  );
  assert.equal(
    services['worker-activity'].environment.TEMPORAL_WORKER_ROLE,
    'activity',
    'Activity Worker 必须显式声明 activity 角色',
  );
  assert.equal(
    services.temporal.environment.POSTGRES_SEEDS,
    'db',
    'Temporal 必须使用主 Postgres，而不是独立数据库容器',
  );
  assert.equal(services.temporal.depends_on.db.condition, 'service_healthy');
  for (const name of [
    'app',
    'db',
    'redis',
    'temporal',
    'worker-orchestrator',
    'worker-activity',
  ]) {
    assert.ok(services[name].mem_limit, `${name} 必须设置 mem_limit`);
  }

  const debugServices = readDevelopmentComposeJson([
    '--profile',
    'debug',
  ]).services;
  assert.ok(debugServices['temporal-ui'], 'debug profile 应包含 Temporal UI');
  assert.equal(debugServices['temporal-ui'].ports[0].published, '8233');
});

test('渲染 Activity Worker 带 Chromium、中文字体与可写帧目录', () => {
  const config = readDevelopmentComposeJson();
  const services = config.services;
  const activity = services['worker-activity'];
  const source = readDevelopmentComposeSource();

  assert.equal(
    activity.environment.HTML_RENDER_CHROME_PATH,
    '/usr/bin/chromium',
    '渲染 Worker 必须指向镜像内的 Chromium',
  );
  assert.equal(
    activity.environment.HTML_RENDER_TMP_ROOT,
    '/var/tmp/html-render',
    '帧图必须写到容器内可写临时目录',
  );
  assert.equal(
    activity.environment.HTML_RENDER_MAX_CONCURRENCY,
    '1',
    '并发渲染会同时抢 Chromium 内存与临时磁盘，默认必须串行',
  );
  // tmpfs 的页计入 mem_limit，与 Chromium 抢同一份内存预算，不能承接大量帧图。
  assert.equal(
    activity.tmpfs,
    undefined,
    '帧目录不得挂 tmpfs：它计入容器内存上限',
  );
  const framesMount = activity.volumes.find(
    (entry) => entry.target === '/var/tmp/html-render',
  );
  assert.ok(framesMount, '帧目录必须挂载可写磁盘卷');
  assert.equal(framesMount.type, 'volume', '帧目录必须是磁盘卷，不能是 tmpfs');
  assert.match(
    framesMount.source,
    /render_frames$/,
    '帧目录卷必须有独立命名，便于定位与清理',
  );
  assert.ok(
    Object.keys(config.volumes ?? {}).some((name) =>
      name.endsWith('render_frames'),
    ),
    '帧目录卷必须在顶层 volumes 里声明',
  );
  assert.ok(
    activity.mem_limit,
    '渲染 Worker 必须保留独立内存上限，不能与帧目录共用预算',
  );

  // 浏览器与 ffmpeg 只装在渲染镜像里：API 镜像不应该被一起养肥
  assert.match(source, /target: development-activity/);
  assert.match(
    source,
    /worker-activity:\n[\s\S]*?build: \*render-build/,
    '渲染 Worker 必须使用带浏览器依赖的镜像',
  );

  const dockerfileStages = readDockerfileStages();
  const activityStage = dockerfileStages.get('development-activity');
  assert.ok(activityStage, 'Dockerfile 缺少 development-activity 阶段');
  for (const packageName of ['chromium', 'fonts-noto-cjk', 'ffmpeg']) {
    assert.match(
      activityStage,
      new RegExp(`\\b${packageName}\\b`),
      `渲染镜像必须安装 ${packageName}`,
    );
  }
  assert.match(activityStage, /--no-install-recommends/);
  for (const name of ['development-activity', 'production-activity']) {
    const stage = dockerfileStages.get(name);
    assert.ok(stage, `缺少 ${name} 镜像阶段`);
    assert.match(stage, /chromium-sandbox/, '必须显式安装 Chromium 沙箱');
    const users = [...stage.matchAll(/^USER\s+(\S+)/gm)];
    assert.equal(users.at(-1)?.[1], 'node', '渲染 Worker 不得以 root 运行');
    assert.match(
      stage,
      /chown -R node:node .*\/var\/tmp\/html-render/,
      '非 root Worker 必须能写入帧目录',
    );
    assert.doesNotMatch(stage, /--no-sandbox/);
  }
  const appStage = dockerfileStages.get('development');
  assert.ok(appStage, 'Dockerfile 缺少 development 阶段');
  assert.doesNotMatch(
    appStage,
    /chromium|fonts-noto-cjk|ffmpeg/,
    'API 镜像不得安装浏览器与 ffmpeg',
  );
});

test('开发 Compose 在工作区 bootstrap 成功后启动 API', () => {
  const config = readDevelopmentComposeConfig();
  const structuredConfig = readDevelopmentComposeJson();
  const source = readDevelopmentComposeSource();

  assert.ok(
    /^  workspace-bootstrap:$/m.test(config),
    '开发 Compose 缺少 workspace-bootstrap 服务',
  );
  for (const serviceName of ['app', 'worker-orchestrator', 'worker-activity']) {
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

test('仅渲染 Worker 获得命名空间能力且不得关闭容器安全策略', () => {
  const services = readDevelopmentComposeJson().services;
  const activity = services['worker-activity'];
  assert.deepEqual(activity.cap_add, ['SYS_ADMIN']);
  for (const [name, service] of Object.entries(services)) {
    assert.notEqual(service.privileged, true, `${name} 不得使用特权容器`);
    assert.ok(
      (service.security_opt ?? []).every(
        (option) => !option.includes('unconfined'),
      ),
      `${name} 不得关闭默认安全策略`,
    );
    if (name !== 'worker-activity') {
      assert.ok(
        !(service.cap_add ?? []).includes('SYS_ADMIN'),
        `${name} 不得继承渲染沙箱所需能力`,
      );
    }
  }
});

test('默认 Docker 构建保持 API 入口而非渲染 Worker', () => {
  const stages = readDockerfileStages();
  const lastStage = [...stages.keys()].at(-1);
  const source = readFileSync(resolve(apiRoot, 'Dockerfile'), 'utf8');
  assert.equal(lastStage, 'production-api');
  assert.match(source, /^FROM production AS production-api$/m);
  assert.match(stages.get('production'), /CMD \["node", "dist\/src\/main"\]/);
  assert.doesNotMatch(stages.get(lastStage), /CMD|USER|ENV/);
  assert.match(
    stages.get('production-activity'),
    /CMD \["node", "dist\/src\/temporal\/worker"\]/,
  );
});
