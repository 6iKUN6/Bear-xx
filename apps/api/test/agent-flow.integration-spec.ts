import { Test, TestingModule } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import {
  AgentFlowVersionStatus,
  ConversationTraceItemStatus,
  ConversationTraceItemType,
  StreamTaskStatus,
} from '@prisma/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { StreamTaskEventType } from '@litter-bear/types/protocol';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { AgentCheckpointerService } from '../src/modules/ai/agents/common-chat-agent';
import { calculateFlowDefinitionDigest } from '../src/modules/agent-flow/definition/flow-definition.digest';
import { AgentFlowActivities } from '../src/modules/agent-flow/temporal/agent-flow.activities';
import {
  TemporalClientService,
  createAgentFlowWorkflowStartOptions,
} from '../src/modules/agent-flow/temporal/temporal-client.service';
import { AgentFlowSignalOutboxService } from '../src/modules/agent-flow/temporal/agent-flow-signal-outbox.service';
import { AgentFlowCancellationDispatcherService } from '../src/modules/agent-flow/temporal/agent-flow-cancellation-dispatcher.service';
import { StreamTaskSnapshotService } from '../src/modules/stream-task/stream-task-snapshot.service';
import { StreamTaskService } from '../src/modules/stream-task/stream-task.service';

interface AgentFlowE2eEnvironment {
  databaseUrl: string;
  redisHost: string;
  redisPort: string;
  redisPassword?: string;
  temporalTestServerPath?: string;
}

interface CreatedAgentFlowFixture {
  userId: string;
  agentId: string;
  flowId: string;
  flowVersionId: string;
  conversationId: string;
  taskId: string;
}

interface StartedTemporalWorkers {
  workers: Worker[];
  runs: Promise<void>[];
}

const TEST_TIMEOUT_MS = 30_000;
const originalEnvironment = { ...process.env };

jest.setTimeout(60_000);

describe('AgentFlow 基础设施集成（E2E）', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService | undefined;
  let redis: RedisService | undefined;
  let streamTaskService: StreamTaskService | undefined;
  let snapshotService: StreamTaskSnapshotService | undefined;
  let testEnvironment: TestWorkflowEnvironment | undefined;
  let temporalWorkers: StartedTemporalWorkers | undefined;
  let fixture: CreatedAgentFlowFixture | undefined;

  beforeAll(async () => {
    const environment = readAgentFlowE2eEnvironment();
    applyAgentFlowE2eEnvironment(environment);
    testEnvironment = await TestWorkflowEnvironment.createTimeSkipping(
      environment.temporalTestServerPath
        ? {
            server: {
              executable: {
                type: 'existing-path',
                path: environment.temporalTestServerPath,
              },
            },
          }
        : undefined,
    );

    const taskQueueSuffix = randomUUID();
    const orchestratorTaskQueue = `agent-flow-e2e-orchestrator-${taskQueueSuffix}`;
    const activityTaskQueue = `agent-flow-e2e-activity-${taskQueueSuffix}`;
    const temporalClient = createTestTemporalClient(
      testEnvironment,
      orchestratorTaskQueue,
      activityTaskQueue,
    );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TemporalClientService)
      .useValue(temporalClient)
      .overrideProvider(AgentCheckpointerService)
      .useValue({ get: () => undefined })
      .overrideProvider(AgentFlowSignalOutboxService)
      .useValue({})
      .overrideProvider(AgentFlowCancellationDispatcherService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    const resolvedPrisma = app.get(PrismaService);
    const resolvedRedis = app.get(RedisService);
    await resolvedPrisma.$queryRawUnsafe('SELECT 1');
    await resolvedRedis.ping();
    prisma = resolvedPrisma;
    redis = resolvedRedis;
    streamTaskService = app.get(StreamTaskService);
    snapshotService = app.get(StreamTaskSnapshotService);
    const activities = app.get(AgentFlowActivities);
    temporalWorkers = await startTemporalWorkers(
      testEnvironment,
      orchestratorTaskQueue,
      activityTaskQueue,
      activities,
    );
  });

  afterAll(async () => {
    try {
      await cleanupFixture(prisma, redis, fixture);
    } finally {
      await stopTemporalWorkers(temporalWorkers);
      await app?.close();
      await testEnvironment?.teardown();
      restoreProcessEnvironment();
    }
  });

  it('真实推进已发布的条件 Flow，并将低频事件写入 PostgreSQL、trace 与 Redis Stream', async () => {
    if (!prisma || !streamTaskService || !snapshotService) {
      throw new Error('AgentFlow E2E 基础设施未初始化');
    }

    fixture = await createConditionFlowFixture(prisma, streamTaskService);

    const completedTask = await waitForCompletedTask(prisma, fixture.taskId);
    expect(completedTask.status).toBe(StreamTaskStatus.COMPLETED);
    expect(completedTask.temporalWorkflowId).toBe(fixture.taskId);
    expect(completedTask.temporalRunId).toBeTruthy();
    expect(completedTask.flowVersionId).toBe(fixture.flowVersionId);
    expect(completedTask.flowDigest).toMatch(/^[a-f0-9]{64}$/);

    const events = await prisma.streamTaskEvent.findMany({
      where: { taskId: fixture.taskId },
      orderBy: { eventId: 'asc' },
      select: { eventId: true, eventName: true },
    });
    const expectedEventNames = [
      StreamTaskEventType.FlowRunStarted,
      StreamTaskEventType.FlowNodeStarted,
      StreamTaskEventType.FlowNodeCompleted,
      StreamTaskEventType.MessageDone,
      StreamTaskEventType.TaskCompleted,
    ];
    expect(events.map((event) => event.eventName)).toEqual(expectedEventNames);
    expect(events.map((event) => event.eventId)).toEqual([1, 2, 3, 4, 5]);

    const traces = await prisma.conversationTurnTraceItem.findMany({
      where: { taskId: fixture.taskId },
      select: { type: true, status: true, nodeKey: true },
    });
    expect(traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: ConversationTraceItemType.WORKFLOW_STEP,
          status: ConversationTraceItemStatus.SUCCESS,
          nodeKey: 'ready',
        }),
        expect.objectContaining({
          type: ConversationTraceItemType.MESSAGE_FINALIZE,
          status: ConversationTraceItemStatus.SUCCESS,
        }),
      ]),
    );

    const frames = await snapshotService.readBufferedFramesAfter(
      fixture.taskId,
      '0',
    );
    expect(frames.map((frame) => frame.event)).toEqual(expectedEventNames);
    expect(frames.map(readFrameEventType)).toEqual(expectedEventNames);
  });
});

/**
 * 读取 AgentFlow 集成测试所需的隔离基础设施配置
 * @returns 返回独立 PostgreSQL、Redis 与可选 Temporal Test Server 路径
 * @description 只接受显式的 AGENT_FLOW_E2E_* 环境变量，且测试数据库名必须包含 test 或 e2e，避免测试脚本误写开发库。
 */
function readAgentFlowE2eEnvironment(): AgentFlowE2eEnvironment {
  const databaseUrl = requireEnvironmentValue('AGENT_FLOW_E2E_DATABASE_URL');
  const redisHost = requireEnvironmentValue('AGENT_FLOW_E2E_REDIS_HOST');
  const redisPort = process.env.AGENT_FLOW_E2E_REDIS_PORT?.trim() || '6379';
  const temporalTestServerPath = process.env.TEMPORAL_TEST_SERVER_PATH?.trim();
  let databaseName: string;
  try {
    databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error('AGENT_FLOW_E2E_DATABASE_URL 必须是合法的 PostgreSQL URL');
  }
  if (!/(test|e2e)/i.test(databaseName)) {
    throw new Error(
      'AGENT_FLOW_E2E_DATABASE_URL 必须指向名称包含 test 或 e2e 的隔离数据库',
    );
  }
  if (!/^\d+$/.test(redisPort)) {
    throw new Error('AGENT_FLOW_E2E_REDIS_PORT 必须是有效端口号');
  }
  if (process.arch === 'arm64' && !temporalTestServerPath) {
    throw new Error(
      'Apple Silicon 上必须设置 TEMPORAL_TEST_SERVER_PATH 为兼容 Temporal Test Server 二进制路径',
    );
  }
  return {
    databaseUrl,
    redisHost,
    redisPort,
    ...(process.env.AGENT_FLOW_E2E_REDIS_PASSWORD?.trim()
      ? { redisPassword: process.env.AGENT_FLOW_E2E_REDIS_PASSWORD.trim() }
      : {}),
    ...(temporalTestServerPath ? { temporalTestServerPath } : {}),
  };
}

/**
 * 将隔离配置映射到应用实际读取的环境变量
 * @param environment 已校验的 AgentFlow E2E 基础设施配置
 * @returns 无返回值
 * @description 在创建 Nest 容器前完成映射，使 Prisma 和 RedisService 只连接测试专用目标，不依赖开发环境的 .env 值。
 */
function applyAgentFlowE2eEnvironment(
  environment: AgentFlowE2eEnvironment,
): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = environment.databaseUrl;
  process.env.REDIS_HOST = environment.redisHost;
  process.env.REDIS_PORT = environment.redisPort;
  if (environment.redisPassword) {
    process.env.REDIS_PASSWORD = environment.redisPassword;
  } else {
    delete process.env.REDIS_PASSWORD;
  }
  process.env.JWT_ACCESS_SECRET = 'agent-flow-e2e-access-secret';
  process.env.JWT_REFRESH_SECRET = 'agent-flow-e2e-refresh-secret';
}

/**
 * 构造连接到 Temporal Test Server 的最小客户端替身
 * @param testEnvironment 已启动的 Temporal Test Server 环境
 * @param orchestratorTaskQueue Workflow Worker 消费的队列
 * @param activityTaskQueue Activity Worker 消费的队列
 * @returns 返回只实现 FlowTaskDispatcher 所需 startWorkflow 方法的客户端
 * @description 保留 TemporalClientService 的启动参数和幂等策略，只替换网络连接目标，确保派发 seam 仍走真实 Temporal Workflow。
 */
function createTestTemporalClient(
  testEnvironment: TestWorkflowEnvironment,
  orchestratorTaskQueue: string,
  activityTaskQueue: string,
): Pick<TemporalClientService, 'startWorkflow'> {
  return {
    async startWorkflow(input) {
      const handle = await testEnvironment.client.workflow.start(
        'agentFlowWorkflow',
        createAgentFlowWorkflowStartOptions(input, {
          address: 'temporal-test-server',
          namespace: 'default',
          orchestratorTaskQueue,
          activityTaskQueue,
          tls: false,
        }),
      );
      return {
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
      };
    },
  };
}

/**
 * 启动本次 E2E 独占的 Workflow 与 Activity Worker
 * @param testEnvironment 已启动的 Temporal Test Server 环境
 * @param orchestratorTaskQueue Workflow 队列名
 * @param activityTaskQueue Activity 队列名
 * @param activities 注入真实数据库和 Redis 依赖的 Activity 实例
 * @returns 返回 Worker 及其运行 Promise，供测试结束时优雅停止
 * @description 编排 Worker 只装载 Workflow 代码，Activity Worker 只装载 Nest 注入后的真实 Activity，保持生产部署的职责隔离。
 */
async function startTemporalWorkers(
  testEnvironment: TestWorkflowEnvironment,
  orchestratorTaskQueue: string,
  activityTaskQueue: string,
  activities: AgentFlowActivities,
): Promise<StartedTemporalWorkers> {
  const orchestratorWorker = await Worker.create({
    connection: testEnvironment.nativeConnection,
    taskQueue: orchestratorTaskQueue,
    workflowsPath:
      require.resolve('../src/temporal/workflows/agent-flow.workflow'),
  });
  const activityWorker = await Worker.create({
    connection: testEnvironment.nativeConnection,
    taskQueue: activityTaskQueue,
    activities: activities.getActivityHandlers(),
  });
  return {
    workers: [orchestratorWorker, activityWorker],
    runs: [orchestratorWorker.run(), activityWorker.run()],
  };
}

/**
 * 停止本次 E2E 启动的 Temporal Worker
 * @param temporalWorkers Worker 与运行 Promise；未启动时可为空
 * @returns 无返回值
 * @description 先请求优雅停止，再等待轮询循环退出，避免 Jest 因 Worker 活动句柄无法结束。
 */
async function stopTemporalWorkers(
  temporalWorkers: StartedTemporalWorkers | undefined,
): Promise<void> {
  if (!temporalWorkers) {
    return;
  }
  for (const worker of temporalWorkers.workers) {
    worker.shutdown();
  }
  await Promise.all(temporalWorkers.runs);
}

/**
 * 创建不触发 LLM 的已发布条件 Flow 及其 StreamTask
 * @param prisma 已连接到隔离数据库的 Prisma 服务
 * @param streamTaskService 真实文本任务创建入口
 * @returns 返回后续断言和清理需要的全部业务标识
 * @description 条件节点会真实写入 Flow 运行事件、trace 与 Redis 帧，但不调用模型、工具、Planner 或 MCP，专注验证基础设施链路。
 */
async function createConditionFlowFixture(
  prisma: PrismaService,
  streamTaskService: StreamTaskService,
): Promise<CreatedAgentFlowFixture> {
  const suffix = randomUUID();
  const definition = createConditionOnlyDefinition();
  const digest = calculateFlowDefinitionDigest(definition);
  const user = await prisma.user.create({
    data: { nickname: `AgentFlow E2E ${suffix}` },
  });
  const flow = await prisma.agentFlow.create({
    data: {
      name: `AgentFlow E2E ${suffix}`,
      description: '仅验证基础设施链路，不调用真实 LLM',
      createdById: user.id,
    },
  });
  const flowVersion = await prisma.agentFlowVersion.create({
    data: {
      flowId: flow.id,
      version: 1,
      status: AgentFlowVersionStatus.PUBLISHED,
      definition,
      digest,
      schemaVersion: definition.schemaVersion,
      createdById: user.id,
      publishedAt: new Date(),
    },
  });
  await prisma.agentFlow.update({
    where: { id: flow.id },
    data: { publishedVersionId: flowVersion.id },
  });
  const agent = await prisma.agent.create({
    data: {
      name: `AgentFlow E2E ${suffix}`,
      modelPreset: 'openai:gpt-4.1',
      defaultFlowVersionId: flowVersion.id,
      createdById: user.id,
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: 'AgentFlow E2E',
      isTest: true,
      agentIds: [agent.id],
      defaultAgentId: agent.id,
    },
  });
  const task = await streamTaskService.createChatTask(
    conversation.id,
    '验证 AgentFlow 基础设施链路',
    user.id,
    undefined,
    agent.id,
    true,
  );
  return {
    userId: user.id,
    agentId: agent.id,
    flowId: flow.id,
    flowVersionId: flowVersion.id,
    conversationId: conversation.id,
    taskId: task.taskId,
  };
}

/**
 * 创建用于基础设施 E2E 的确定性条件 Flow
 * @returns 返回只含一个 condition 节点的合法 FlowDefinition
 * @description 节点没有后继边，因而 true 或 false 分支都自然结束；这里不需要模型、工具、计划器或 MCP。
 */
function createConditionOnlyDefinition(): FlowDefinition {
  return {
    schemaVersion: 1,
    kind: 'agent-flow',
    name: 'AgentFlow E2E 条件链路',
    description: '验证真实 PostgreSQL、Redis 与 Temporal 的最小 Flow',
    policy: {
      maxSteps: 1,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxDurationSeconds: 60,
    },
    nodes: [
      {
        id: 'ready',
        type: 'condition',
        config: {
          field: 'started',
          operator: 'equals',
          value: true,
        },
      },
    ],
    edges: [],
  };
}

/**
 * 轮询等待指定任务进入完成状态
 * @param prisma 已连接到隔离数据库的 Prisma 服务
 * @param taskId 待观察的 StreamTask ID
 * @returns 返回已完成的 StreamTask 最小记录
 * @description Temporal Worker 是异步运行的；只等待 COMPLETED，超时会带上最后观察到的状态以便定位基础设施故障。
 */
async function waitForCompletedTask(
  prisma: PrismaService,
  taskId: string,
): Promise<{
  status: StreamTaskStatus;
  temporalWorkflowId: string | null;
  temporalRunId: string | null;
  flowVersionId: string | null;
  flowDigest: string | null;
}> {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  let lastStatus: StreamTaskStatus | undefined;
  while (Date.now() < deadline) {
    const task = await prisma.streamTask.findUnique({
      where: { id: taskId },
      select: {
        status: true,
        temporalWorkflowId: true,
        temporalRunId: true,
        flowVersionId: true,
        flowDigest: true,
      },
    });
    if (!task) {
      throw new Error('等待期间测试任务被意外删除');
    }
    lastStatus = task.status;
    if (task.status === StreamTaskStatus.COMPLETED) {
      return task;
    }
    if (
      task.status === StreamTaskStatus.ERROR ||
      task.status === StreamTaskStatus.CANCELED ||
      task.status === StreamTaskStatus.EXPIRED
    ) {
      throw new Error(`AgentFlow 任务异常结束，状态为 ${task.status}`);
    }
    await wait(100);
  }
  throw new Error(`等待 AgentFlow 任务完成超时，最后状态为 ${lastStatus}`);
}

/**
 * 清理本次 E2E 创建的精确业务记录和 Redis Stream
 * @param prisma 已连接到隔离数据库的 Prisma 服务
 * @param redis 已连接到隔离 Redis 的客户端
 * @param fixture 本次测试创建的业务标识；未创建时可为空
 * @returns 无返回值
 * @description 只删除由唯一测试 ID 创建的记录，不执行 flush、truncate 或其他共享基础设施级清理。
 */
async function cleanupFixture(
  prisma: PrismaService | undefined,
  redis: RedisService | undefined,
  fixture: CreatedAgentFlowFixture | undefined,
): Promise<void> {
  if (!fixture || !prisma) {
    return;
  }
  await redis?.del(`stream-task:frames:${fixture.taskId}`);
  await prisma.streamTask.deleteMany({ where: { id: fixture.taskId } });
  await prisma.conversation.deleteMany({
    where: { id: fixture.conversationId },
  });
  await prisma.agent.updateMany({
    where: { id: fixture.agentId },
    data: { defaultFlowVersionId: null },
  });
  await prisma.agent.deleteMany({ where: { id: fixture.agentId } });
  await prisma.agentFlow.updateMany({
    where: { id: fixture.flowId },
    data: { publishedVersionId: null },
  });
  await prisma.agentFlowVersion.deleteMany({
    where: { id: fixture.flowVersionId },
  });
  await prisma.agentFlow.deleteMany({ where: { id: fixture.flowId } });
  await prisma.user.deleteMany({ where: { id: fixture.userId } });
}

/**
 * 读取一个必填环境变量
 * @param key 环境变量名
 * @returns 返回去除首尾空白后的值
 * @description 空值与未配置都会抛出明确错误，避免 E2E 隐式使用开发环境连接配置。
 */
function requireEnvironmentValue(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} 未配置，拒绝运行 AgentFlow 基础设施 E2E`);
  }
  return value;
}

/**
 * 等待一个短轮询间隔
 * @param milliseconds 等待毫秒数
 * @returns 返回在定时器完成后 resolve 的 Promise
 * @description 只用于 E2E 观察异步 Temporal Activity 的状态收敛，不参与业务重试或超时语义。
 */
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 读取 Redis 帧中的标准事件类型
 * @param frame Redis Stream 回放得到的 SSE 帧
 * @returns 返回经过 JSON 结构校验的事件类型
 * @description E2E 不信任 Redis 原始字符串；若帧不是当前协议的 JSON 信封则抛错，避免把格式错误误判为事件顺序错误。
 */
function readFrameEventType(frame: { data: string }): StreamTaskEventType {
  const parsed: unknown = JSON.parse(frame.data);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('type' in parsed) ||
    typeof parsed.type !== 'string'
  ) {
    throw new Error('Redis Stream 帧缺少标准事件 type');
  }
  return parsed.type as StreamTaskEventType;
}

/**
 * 还原本测试进程修改的环境变量
 * @returns 无返回值
 * @description Jest 进程可能在同一调用中继续加载其他测试，因此 E2E 结束后恢复启动时的环境变量快照。
 */
function restoreProcessEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnvironment)) {
    process.env[key] = value;
  }
}
