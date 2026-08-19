#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const apiRoot = resolve(__dirname, '..');
const composeFile = resolve(apiRoot, 'docker-compose.agent-flow-e2e.yml');
const composeProjectName = `litter-bear-agent-flow-e2e-${process.pid}`;
const defaultEnvironmentFile = resolve(apiRoot, '.env.agent-flow-e2e');
let composeStarted = false;
let cleaningUp = false;

/**
 * 解析 Docker Compose 查询到的宿主机端口
 * @param output Docker Compose `port` 命令的标准输出
 * @returns 返回连接服务所需的宿主机地址和端口
 * @description 支持 Docker Desktop 可能返回的 IPv4 与方括号包裹的 IPv6 格式；其余格式直接失败，避免拼出错误连接串。
 */
function parseDockerComposePort(output) {
  const value = output.trim();
  const ipv6Match = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6Match) {
    return { host: ipv6Match[1], port: ipv6Match[2] };
  }
  const ipv4Match = value.match(/^([^:\s]+):(\d+)$/);
  if (ipv4Match) {
    return { host: ipv4Match[1], port: ipv4Match[2] };
  }
  throw new Error(`无法解析 Docker Compose 端口输出：${value || '(空)'}`);
}

/**
 * 读取本地 AgentFlow E2E 环境文件并补充启动环境
 * @param environmentFile 本地环境文件的绝对路径
 * @param baseEnvironment 脚本启动时已存在的环境变量
 * @returns 返回以显式环境变量优先的完整环境变量对象
 * @description 环境文件仅用于机器相关配置，例如 Apple Silicon 的 Temporal Test Server 路径；终端与 CI 显式注入的同名变量不会被覆盖。
 */
function loadLocalE2eEnvironment(environmentFile, baseEnvironment) {
  if (!existsSync(environmentFile)) {
    return { ...baseEnvironment };
  }
  const fileEnvironment = parseEnvironmentFile(
    readFileSync(environmentFile, 'utf8'),
  );
  return { ...fileEnvironment, ...baseEnvironment };
}

/**
 * 解析简单的 dotenv 格式文本
 * @param content 环境文件原始文本
 * @returns 返回解析后的环境变量键值对
 * @description 支持空行、注释和单引号或双引号包裹的值；不实现变量插值，避免把 Shell 语义隐式带入测试配置。
 */
function parseEnvironmentFile(content) {
  const parsed = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }
    const separatorIndex = trimmedLine.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error(`E2E 环境文件包含无效行：${trimmedLine}`);
    }
    const key = trimmedLine.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`E2E 环境文件包含无效变量名：${key}`);
    }
    const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
    parsed[key] = removeMatchingQuotes(rawValue);
  }
  return parsed;
}

/**
 * 去除成对包裹环境变量值的引号
 * @param value 环境变量的原始值
 * @returns 返回去除成对引号后的变量值
 * @description 仅处理首尾同为单引号或双引号的情况，其他内容按原样保留。
 */
function removeMatchingQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 执行会把输出直接转发给终端的子进程命令
 * @param command 可执行文件名称
 * @param args 命令参数
 * @param environment 子进程环境变量
 * @returns 无返回值
 * @description 命令启动失败或非零退出均抛出错误，使外层 finally 仍能销毁已启动的 E2E 容器。
 */
function runCommand(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: apiRoot,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`无法执行 ${command}：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 执行失败，退出码 ${result.status}`);
  }
}

/**
 * 执行并读取 Docker Compose 子命令的标准输出
 * @param args Docker Compose 子命令参数
 * @param environment 子进程环境变量
 * @returns 返回去除空白后的标准输出
 * @description 仅用于 `docker compose port`，以便将 Docker 动态分配的端口注入到后续 Prisma 与 Jest 子进程。
 */
function runComposeCommandAndCapture(args, environment) {
  const result = spawnSync(
    'docker',
    createComposeArguments(args),
    {
      cwd: apiRoot,
      env: environment,
      encoding: 'utf8',
    },
  );
  if (result.error) {
    throw new Error(`无法执行 docker compose：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} 执行失败：${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout;
}

/**
 * 执行 Docker Compose 子命令
 * @param args Docker Compose 子命令参数
 * @param environment 子进程环境变量
 * @returns 无返回值
 * @description 统一携带本次运行独占的 project 名与 E2E Compose 文件，避免影响开发环境已有 Compose 项目。
 */
function runComposeCommand(args, environment) {
  runCommand('docker', createComposeArguments(args), environment);
}

/**
 * 构造绑定本次 E2E 项目的 Docker Compose 参数
 * @param args Docker Compose 子命令参数
 * @returns 返回完整的 docker 参数数组
 * @description 每次运行使用进程 ID 区分 Compose project，允许不同终端并行运行并避免容器和网络命名冲突。
 */
function createComposeArguments(args) {
  return [
    'compose',
    '--project-name',
    composeProjectName,
    '--file',
    composeFile,
    ...args,
  ];
}

/**
 * 将 Docker 动态端口映射为 AgentFlow E2E 的连接环境变量
 * @param environment 已加载本地配置后的基础环境变量
 * @param postgresAddress PostgreSQL 容器暴露到宿主机的地址
 * @param redisAddress Redis 容器暴露到宿主机的地址
 * @returns 返回供迁移和 Jest 使用的隔离基础设施环境变量
 * @description 连接信息始终由本次脚本启动的容器决定，不接受外部数据库或 Redis 覆盖，杜绝误写开发基础设施。
 */
function createInfrastructureEnvironment(
  environment,
  postgresAddress,
  redisAddress,
) {
  const postgresHost = formatHostForUrl(postgresAddress.host);
  return {
    ...environment,
    NODE_ENV: 'test',
    AGENT_FLOW_E2E_DATABASE_URL: `postgresql://postgres:postgres@${postgresHost}:${postgresAddress.port}/litter_bear_e2e`,
    AGENT_FLOW_E2E_REDIS_HOST: redisAddress.host,
    AGENT_FLOW_E2E_REDIS_PORT: redisAddress.port,
    DATABASE_URL: `postgresql://postgres:postgres@${postgresHost}:${postgresAddress.port}/litter_bear_e2e`,
    REDIS_HOST: redisAddress.host,
    REDIS_PORT: redisAddress.port,
  };
}

/**
 * 格式化 URL 中的宿主机地址
 * @param host Docker Compose 暴露的宿主机地址
 * @returns 返回可嵌入 URL authority 的地址
 * @description IPv6 地址在 URL 中必须使用方括号包裹，IPv4 与主机名则保持原样。
 */
function formatHostForUrl(host) {
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * 校验当前机器是否满足 Temporal Test Server 的启动条件
 * @param environment 已加载本地配置后的环境变量
 * @returns 无返回值
 * @description Apple Silicon 需要通过本地环境文件或 CI 变量提供兼容二进制路径，并在拉起 Docker 前尽早失败。
 */
function validateTemporalTestServerEnvironment(environment) {
  const temporalTestServerPath = environment.TEMPORAL_TEST_SERVER_PATH?.trim();
  if (process.arch === 'arm64' && !temporalTestServerPath) {
    throw new Error(
      'Apple Silicon 上请在 apps/api/.env.agent-flow-e2e 中设置 TEMPORAL_TEST_SERVER_PATH，再运行 AgentFlow E2E',
    );
  }
  if (temporalTestServerPath && !existsSync(temporalTestServerPath)) {
    throw new Error(
      `TEMPORAL_TEST_SERVER_PATH 不存在或不可访问：${temporalTestServerPath}`,
    );
  }
}

/**
 * 销毁本次 E2E 启动的 Docker Compose 项目
 * @param environment 子进程环境变量
 * @returns 无返回值
 * @description 使用 down --volumes --remove-orphans 删除容器、网络和测试数据卷；清理失败仅写日志，不掩盖测试本身的失败原因。
 */
function cleanupComposeProject(environment) {
  if (!composeStarted || cleaningUp) {
    return;
  }
  cleaningUp = true;
  try {
    runComposeCommand(['down', '--volumes', '--remove-orphans'], environment);
  } catch (error) {
    console.error(
      `[AgentFlow E2E] 清理 Docker Compose 项目失败：${error.message}`,
    );
  } finally {
    composeStarted = false;
    cleaningUp = false;
  }
}

/**
 * 收到进程终止信号时先清理 E2E 基础设施再退出
 * @param signal 进程终止信号名称
 * @param environment 子进程环境变量
 * @returns 无返回值
 * @description 处理 Ctrl+C 和编排环境的 SIGTERM，降低中断测试后残留容器与数据卷的概率。
 */
function registerCleanupSignals(signal, environment) {
  process.once(signal, () => {
    cleanupComposeProject(environment);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

/**
 * 运行完整的 AgentFlow 基础设施 E2E
 * @returns 无返回值
 * @description 依次校验 Temporal 配置、拉起隔离 PostgreSQL 和 Redis、执行 Prisma 迁移、注入动态端口并运行 Jest，最后无条件清理基础设施。
 */
function main() {
  const environmentFile = process.env.AGENT_FLOW_E2E_ENV_FILE
    ? resolve(process.env.AGENT_FLOW_E2E_ENV_FILE)
    : defaultEnvironmentFile;
  const baseEnvironment = loadLocalE2eEnvironment(environmentFile, process.env);
  validateTemporalTestServerEnvironment(baseEnvironment);
  if (existsSync(environmentFile)) {
    console.info(`[AgentFlow E2E] 已加载本地配置：${environmentFile}`);
  }

  registerCleanupSignals('SIGINT', baseEnvironment);
  registerCleanupSignals('SIGTERM', baseEnvironment);
  composeStarted = true;
  try {
    runComposeCommand(['up', '--detach', '--wait'], baseEnvironment);
    const postgresAddress = parseDockerComposePort(
      runComposeCommandAndCapture(['port', 'postgres', '5432'], baseEnvironment),
    );
    const redisAddress = parseDockerComposePort(
      runComposeCommandAndCapture(['port', 'redis', '6379'], baseEnvironment),
    );
    const infrastructureEnvironment = createInfrastructureEnvironment(
      baseEnvironment,
      postgresAddress,
      redisAddress,
    );
    runCommand('pnpm', ['run', 'db:migrate:deploy'], infrastructureEnvironment);
    runCommand(
      'pnpm',
      [
        'exec',
        'jest',
        '--config',
        './test/jest-agent-flow-e2e.json',
        '--runInBand',
      ],
      infrastructureEnvironment,
    );
  } finally {
    cleanupComposeProject(baseEnvironment);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[AgentFlow E2E] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  loadLocalE2eEnvironment,
  parseDockerComposePort,
};
