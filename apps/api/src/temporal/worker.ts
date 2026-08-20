import { NestFactory } from '@nestjs/core';
import { NativeConnection, Worker } from '@temporalio/worker';
import { AppModule } from '../app.module';
import { AgentFlowActivities } from '../modules/agent-flow/temporal/agent-flow.activities';
import { getAgentFlowWorkflowBuildId } from './agent-flow.workflow-revision';
import {
  getTemporalConnectionOptions,
  getTemporalWorkerConfig,
  type TemporalWorkerConfig,
} from './temporal.config';

type TemporalWorkerRole = 'orchestrator' | 'activity';

/**
 * 启动独立的 AgentFlow Temporal Worker
 * @returns 无返回值
 * @description TEMPORAL_WORKER_ROLE=orchestrator 时只注册纯 Workflow；activity 时才创建 Nest application context 并注册可访问数据库的 Activity。HTTP API 进程不调用此入口。
 */
async function bootstrapTemporalWorker(): Promise<void> {
  const role = getTemporalWorkerRole(process.env);
  const config = getTemporalWorkerConfig(process.env);

  if (role === 'orchestrator') {
    await runOrchestratorWorker(config);
    return;
  }
  await runActivityWorker(config);
}

/**
 * 读取并校验当前 Worker 的进程角色
 * @param environment 待读取的环境变量集合
 * @returns 返回 orchestrator 或 activity 角色
 * @description 强制显式指定角色，避免单一进程同时消费 Workflow 与 Activity 任务队列而破坏部署隔离。
 */
function getTemporalWorkerRole(
  environment: Readonly<Record<string, string | undefined>>,
): TemporalWorkerRole {
  const role = environment.TEMPORAL_WORKER_ROLE?.trim();
  if (role === 'orchestrator' || role === 'activity') {
    return role;
  }
  throw new Error(
    'TEMPORAL_WORKER_ROLE 必须是 orchestrator 或 activity，不能启动混合 Worker',
  );
}

/**
 * 运行只处理 Workflow Task 的编排 Worker
 * @param config 已通过严格校验的 Temporal 配置
 * @returns 无返回值
 * @description 此进程不创建 Nest application context，也不注册 Activity，因此 Workflow 代码无法直接获得数据库、Redis、LLM 或 MCP 能力。
 */
async function runOrchestratorWorker(
  config: TemporalWorkerConfig,
): Promise<void> {
  const connection = await NativeConnection.connect(
    getTemporalConnectionOptions(config),
  );
  try {
    const worker = await Worker.create({
      connection,
      namespace: config.namespace,
      taskQueue: config.orchestratorTaskQueue,
      workflowsPath: require.resolve('./workflows/agent-flow.workflow'),
      // 让每个 Workflow Task 携带推进它的代码修订，便于事后定位非确定性问题；
      // 未开启 useVersioning，因此不参与任务路由，仅作元数据。
      buildId: getAgentFlowWorkflowBuildId(),
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

/**
 * 运行只处理 Activity Task 的业务 Worker
 * @param config 已通过严格校验的 Temporal 配置
 * @returns 无返回值
 * @description 只有该进程创建 Nest application context，以便 Activity 受 Nest DI、数据库连接和业务模块约束；它不注册任何 Workflow 代码。
 */
async function runActivityWorker(config: TemporalWorkerConfig): Promise<void> {
  const application = await NestFactory.createApplicationContext(AppModule);
  const connection = await NativeConnection.connect(
    getTemporalConnectionOptions(config),
  );
  try {
    const activities = application.get(AgentFlowActivities);
    const worker = await Worker.create({
      connection,
      namespace: config.namespace,
      taskQueue: config.activityTaskQueue,
      activities: activities.getActivityHandlers(),
      buildId: getAgentFlowWorkflowBuildId(),
    });
    await worker.run();
  } finally {
    await connection.close();
    await application.close();
  }
}

bootstrapTemporalWorker().catch((error: unknown) => {
  console.error('AgentFlow Temporal Worker 启动失败', error);
  process.exitCode = 1;
});
