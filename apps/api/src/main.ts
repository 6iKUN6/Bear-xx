import { createServer } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { API_GLOBAL_PREFIX } from './app.constants';
import { createSwaggerDocument } from './swagger';
import { runEmbeddedAgentFlowWorkers } from './temporal/agent-flow-workers';
import {
  getTemporalWorkerConfig,
  isTemporalEmbeddedWorkersEnabled,
} from './temporal/temporal.config';

const MAX_PORT_ATTEMPTS = 10;
const SERVER_NAME = 'XX SERVER';
/**
 * 探测端口是否可用
 * @param port 待探测端口
 * @returns 端口可用返回 true，被占用或无法绑定返回 false
 * @description 用一个临时 net server 试绑定同款双栈地址（与 Nest app.listen 一致），
 * 探测完立即关闭。相比直接 app.listen 重试，避免 Nest 内部对失败的 listen 再抛一条 EADDRINUSE 错误日志。
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port);
  });
}

/**
 * 从首选端口起顺延寻找可用端口
 * @param preferredPort 首选端口
 * @returns 返回第一个可用端口
 * @description 端口被占用时顺延（3000 → 3001 → …），最多尝试 MAX_PORT_ATTEMPTS 次。
 */
async function findAvailablePort(preferredPort: number): Promise<number> {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = preferredPort + attempt;
    if (await isPortAvailable(port)) {
      return port;
    }
    console.warn(`Port ${port} is in use, trying ${port + 1}...`);
  }

  throw new Error(
    `Could not find an available port (tried ${preferredPort}-${preferredPort + MAX_PORT_ATTEMPTS - 1})`,
  );
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors();
  app.setGlobalPrefix(API_GLOBAL_PREFIX);

  const document = createSwaggerDocument(app);
  SwaggerModule.setup('api-docs', app, document);

  const preferredPort = Number(process.env.PORT) || 3000;
  const port = await findAvailablePort(preferredPort);

  await app.listen(port);
  console.log(`${SERVER_NAME} running on http://localhost:${port}`);
  console.log(`API Prefix: http://localhost:${port}/${API_GLOBAL_PREFIX}`);
  console.log(`API Docs: http://localhost:${port}/api-docs`);

  if (isTemporalEmbeddedWorkersEnabled()) {
    startEmbeddedTemporalWorkers(app);
  }
}

/**
 * 在 API 进程内启动 AgentFlow Worker
 * @param app 已开始监听的 API 应用
 * @returns 无返回值；Worker 在后台运行
 * @description Temporal Runtime 接管 SIGINT/SIGTERM 并优雅停止 Worker，停止后由这里关闭应用并退出。
 * Worker 异常退出时整个进程以非零码退出交给容器重启，不留下「接口正常但 Flow 无人执行」的半活状态。
 */
function startEmbeddedTemporalWorkers(app: INestApplication): void {
  const config = getTemporalWorkerConfig();
  console.log(
    `Temporal Workers embedded: ${config.orchestratorTaskQueue}, ${config.activityTaskQueue}`,
  );
  runEmbeddedAgentFlowWorkers(app, config)
    .catch((error: unknown) => {
      console.error('内嵌 Temporal Worker 异常退出', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await app.close();
      process.exit();
    });
}

bootstrap()
  .then(() => {})
  .catch((error: unknown) => {
    console.error(`${SERVER_NAME} 启动失败`, error);
    process.exitCode = 1;
  });
