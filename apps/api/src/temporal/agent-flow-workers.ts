import type { INestApplicationContext } from '@nestjs/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import { AgentFlowActivities } from '../modules/agent-flow/temporal/agent-flow.activities';
import { getAgentFlowWorkflowBuildId } from './agent-flow.workflow-revision';
import {
  getTemporalConnectionOptions,
  type TemporalWorkerConfig,
} from './temporal.config';

/**
 * 创建只处理 Workflow Task 的编排 Worker
 * @param connection 已建立的 Temporal 连接
 * @param config 已通过严格校验的 Temporal 配置
 * @returns 返回尚未运行的 Worker
 * @description 只注册纯 Workflow；Workflow 代码运行在 SDK 的隔离 VM 中，即使与 Activity 同进程也拿不到数据库、Redis、LLM 或 MCP。
 */
export function createOrchestratorWorker(
  connection: NativeConnection,
  config: TemporalWorkerConfig,
): Promise<Worker> {
  return Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.orchestratorTaskQueue,
    workflowsPath: require.resolve('./workflows/agent-flow.workflow'),
    // 让每个 Workflow Task 携带推进它的代码修订，便于事后定位非确定性问题；
    // 未开启 useVersioning，因此不参与任务路由，仅作元数据。
    buildId: getAgentFlowWorkflowBuildId(),
  });
}

/**
 * 创建只处理 Activity Task 的业务 Worker
 * @param connection 已建立的 Temporal 连接
 * @param config 已通过严格校验的 Temporal 配置
 * @param application 提供 Activity 依赖的 Nest 应用上下文
 * @returns 返回尚未运行的 Worker
 * @description Activity 受 Nest DI、数据库连接和业务模块约束；不注册任何 Workflow 代码。
 */
export function createActivityWorker(
  connection: NativeConnection,
  config: TemporalWorkerConfig,
  application: INestApplicationContext,
): Promise<Worker> {
  return Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.activityTaskQueue,
    activities: application.get(AgentFlowActivities).getActivityHandlers(),
    buildId: getAgentFlowWorkflowBuildId(),
  });
}

/**
 * 在 API 进程内运行编排与 Activity 两个 Worker
 * @param application 已启动的 API 应用
 * @param config 已通过严格校验的 Temporal 配置
 * @returns 两个 Worker 都正常停止后返回；任一异常退出时停止另一个并抛出
 * @description 小规格单机部署用：省掉两个独立 Node 进程和一套重复的 Nest 上下文。两个 Worker
 * 仍分别消费原来的编排与 Activity 队列，拆回独立进程只需改部署配置。
 */
export async function runEmbeddedAgentFlowWorkers(
  application: INestApplicationContext,
  config: TemporalWorkerConfig,
): Promise<void> {
  const connection = await NativeConnection.connect(
    getTemporalConnectionOptions(config),
  );
  try {
    const workers = await Promise.all([
      createOrchestratorWorker(connection, config),
      createActivityWorker(connection, config, application),
    ]);
    await Promise.all(
      workers.map((worker) =>
        worker.run().catch((error: unknown) => {
          // 一个 Worker 挂掉时不能让另一个继续半截运行：Flow 会卡在无人消费的队列上
          for (const other of workers) {
            if (other.getState() === 'RUNNING') other.shutdown();
          }
          throw error;
        }),
      ),
    );
  } finally {
    await connection.close();
  }
}
