/**
 * AgentFlow 真实链路验证脚本
 *
 * 用真实模型驱动一条已发布 Flow 走完 Temporal 编排，观测数据库事件、trace 与任务终态。
 * 单测里模型调用是 mock、集成用例只走不调模型的单 condition 节点，两者都证明不了
 * agent / plan / plan-loop / approval / synthesize 这些节点真的跑得通；本脚本补这一环。
 *
 * 依赖运行中的开发栈（`pnpm dev:docker:up`）：Temporal Server 与两个 Worker 容器负责
 * 真正执行节点，本脚本只创建任务、审批与观测。脚本自身也会起一个 Nest 应用上下文用于
 * 调用真实入口 StreamTaskService.createChatTask，因此运行期间 outbox 与取消派发器会
 * 与 app 容器各跑一份；两者都带租约与幂等条件更新，对调试无害。
 *
 * 用法：
 *   node scripts/debug-agent-flow.cjs [direct|hybrid|plan_execute] [--keep] [--prompt=...]
 *
 *   direct        单 agent 节点：验证模型调用与事件投影
 *   hybrid        plan -> plan-loop -> synthesize：验证多步推进与 Activity 超时余量
 *   plan_execute  plan -> approval -> plan-loop -> synthesize：验证 HITL 闭环
 *   --keep        保留本次产生的数据库数据（默认清理，避免污染开发库）
 */

const fs = require('fs');
const path = require('path');

const apiRoot = path.resolve(__dirname, '..');
loadDotEnv(path.join(apiRoot, '.env'));

// Flow 节点执行发生在 Worker 容器里，本进程只需要 Nest 的 DI 与 Prisma
process.env.TS_NODE_PROJECT = path.join(apiRoot, 'tsconfig.json');
require('ts-node/register');
require('tsconfig-paths/register');

const PRESETS = new Set(['direct', 'hybrid', 'plan_execute']);
const POLL_INTERVAL_MS = 1_000;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'ERROR', 'CANCELED', 'EXPIRED']);
/** 单场景观测上限；plan-loop 每步都是一次真实模型调用，留足余量以便暴露超时问题 */
const OBSERVE_TIMEOUT_MS = 10 * 60 * 1000;
/** 进入 WAITING_HUMAN 后自动审批前的等待，确保审批请求事件与 trace 已落库 */
const APPROVAL_SETTLE_MS = 1_500;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../src/app.module');
  const { PrismaService } = require('../src/prisma/prisma.service');
  const { StreamTaskService } = require('../src/modules/stream-task/stream-task.service');
  const {
    createFlowDefinitionPreset,
  } = require('../src/modules/agent-flow/definition/flow-definition.templates');
  const {
    calculateFlowDefinitionDigest,
  } = require('../src/modules/agent-flow/definition/flow-definition.digest');

  const modelPreset = resolveModelPreset();
  log('start', {
    preset: options.preset,
    modelPreset,
    prompt: options.prompt,
    keepData: options.keep,
  });

  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const prisma = application.get(PrismaService);
  const streamTaskService = application.get(StreamTaskService);
  let fixture;

  try {
    await assertTemporalWorkersReachable(prisma);

    const definition = createFlowDefinitionPreset(options.preset);
    fixture = await createFixture(prisma, {
      definition,
      digest: calculateFlowDefinitionDigest(definition),
      modelPreset,
    });
    log('fixture.created', {
      flowVersionId: fixture.flowVersionId,
      agentId: fixture.agentId,
      nodes: definition.nodes.map((node) => `${node.id}:${node.type}`),
    });

    const task = await streamTaskService.createChatTask(
      fixture.conversationId,
      options.prompt,
      fixture.userId,
      undefined,
      fixture.agentId,
      true,
    );
    fixture.taskId = task.taskId;

    const dispatched = await prisma.streamTask.findUnique({
      where: { id: task.taskId },
      select: {
        flowVersionId: true,
        flowDigest: true,
        currentStep: true,
        temporalWorkflowId: true,
        temporalRunId: true,
      },
    });
    if (!dispatched?.temporalWorkflowId) {
      throw new Error(
        '任务未派发到 Temporal：确认 Agent 绑定了已发布 FlowVersion 且会话为测试会话',
      );
    }
    log('task.dispatched', { taskId: task.taskId, ...dispatched });

    const outcome = await observeTask(prisma, streamTaskService, {
      taskId: task.taskId,
      userId: fixture.userId,
      preset: options.preset,
    });
    reportOutcome(outcome);
  } finally {
    if (fixture && !options.keep) {
      await cleanupFixture(prisma, fixture);
      log('fixture.cleaned', { taskId: fixture.taskId ?? null });
    }
    await application.close();
  }
}

/**
 * 解析命令行参数
 * @param argv 去掉 node 与脚本路径后的参数列表
 * @returns 返回场景预设、提示词与是否保留数据
 * @description 预设是闭集，非法值直接失败而不静默回退，避免把"没跑到目标链路"误读为通过。
 */
function parseArguments(argv) {
  let preset = 'direct';
  let keep = false;
  let prompt;
  for (const argument of argv) {
    if (argument === '--keep') {
      keep = true;
      continue;
    }
    if (argument.startsWith('--prompt=')) {
      prompt = argument.slice('--prompt='.length);
      continue;
    }
    if (!PRESETS.has(argument)) {
      throw new Error(
        `未知场景「${argument}」，可选：${[...PRESETS].join(' / ')}`,
      );
    }
    preset = argument;
  }
  return { preset, keep, prompt: prompt || defaultPrompt(preset) };
}

/**
 * 按场景给出能真正触发目标链路的提示词
 * @param preset 场景预设名
 * @returns 返回中文提示词
 * @description direct 只需一次回复；plan 系列需要能被拆成多步的任务，否则 planner 会退化成单步，
 * 无法暴露 plan-loop 的多轮模型调用与 Activity 超时余量。
 */
function defaultPrompt(preset) {
  if (preset === 'direct') {
    return '用一句话说明 Temporal 的 Workflow 与 Activity 分工。';
  }
  return '请分步骤调研并总结：为 Node.js 服务选型任务编排框架时，Temporal 与 BullMQ 在持久化、重试和人工审批上的差异。';
}

/**
 * 解析本次运行使用的模型预设
 * @returns 返回模型预设 ID
 * @description 默认走 Kimi；预设 ID 形如 platform:model，与 LlmModelRegistry 的注册规则一致。
 * 只读环境变量，不在脚本里硬编码任何密钥。
 */
function resolveModelPreset() {
  const explicit = process.env.DEBUG_AGENT_FLOW_MODEL_PRESET?.trim();
  if (explicit) {
    return explicit;
  }
  if (!process.env.KIMI_API_KEY) {
    throw new Error(
      'KIMI_API_KEY 未配置：设置该变量，或用 DEBUG_AGENT_FLOW_MODEL_PRESET 指定其他已注册预设',
    );
  }
  const model = process.env.KIMI_MODEL?.trim() || 'kimi-k2-0711-preview';
  return `kimi:${model}`;
}

/**
 * 确认 Temporal Worker 侧依赖可达
 * @param prisma 已连接开发库的 Prisma 服务
 * @returns 无返回值
 * @description 只做数据库连通与 outbox 表存在性检查。Worker 是否在线无法直接探测，
 * 但任务长时间停留在初始状态即说明 Worker 未消费，观测阶段会显式报出来。
 */
async function assertTemporalWorkersReachable(prisma) {
  await prisma.$queryRawUnsafe('SELECT 1');
  const [{ count }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_name = 'agent_flow_signal_outbox'`,
  );
  if (count === 0) {
    throw new Error(
      'agent_flow_signal_outbox 表不存在：先执行 pnpm --filter ./apps/api run db:migrate',
    );
  }
}

/**
 * 创建本次验证所需的最小数据集
 * @param prisma 已连接开发库的 Prisma 服务
 * @param input 冻结用的 Flow 定义、摘要与模型预设
 * @returns 返回后续观测与清理需要的各实体 ID
 * @description 全部实体带 debug-agent-flow 前缀，便于人工识别与清理；会话标记为测试会话，
 * 这是 FlowTaskDispatcher 允许走 Temporal 的前置条件。
 */
async function createFixture(prisma, input) {
  const label = `debug-agent-flow ${new Date().toISOString()}`;
  const user = await prisma.user.create({ data: { nickname: label } });
  const flow = await prisma.agentFlow.create({
    data: {
      name: label,
      description: 'AgentFlow 真实链路验证脚本创建，可安全删除',
      createdById: user.id,
    },
  });
  const flowVersion = await prisma.agentFlowVersion.create({
    data: {
      flowId: flow.id,
      version: 1,
      status: 'PUBLISHED',
      definition: input.definition,
      digest: input.digest,
      schemaVersion: input.definition.schemaVersion,
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
      name: label,
      modelPreset: input.modelPreset,
      defaultFlowVersionId: flowVersion.id,
      createdById: user.id,
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: label,
      isTest: true,
      agentIds: [agent.id],
      defaultAgentId: agent.id,
    },
  });
  return {
    userId: user.id,
    flowId: flow.id,
    flowVersionId: flowVersion.id,
    agentId: agent.id,
    conversationId: conversation.id,
    taskId: undefined,
  };
}

/**
 * 轮询观测任务推进直至终态
 * @param prisma 已连接开发库的 Prisma 服务
 * @param streamTaskService 用于提交人工审批决定的真实服务
 * @param context 任务 ID、属主与场景预设
 * @returns 返回事件时间线、审批轮次与终态快照
 * @description 逐条打印新增事件并记录相对耗时，使 plan-loop 每步的真实模型耗时可见；
 * 任务进入 WAITING_HUMAN 时自动提交 approve，以便在无人值守下验证 HITL 闭环。
 */
async function observeTask(prisma, streamTaskService, context) {
  const startedAt = Date.now();
  const timeline = [];
  let seenEventId = 0;
  let approvals = 0;
  let lastStatus;

  while (Date.now() - startedAt < OBSERVE_TIMEOUT_MS) {
    const events = await prisma.streamTaskEvent.findMany({
      where: { taskId: context.taskId, eventId: { gt: seenEventId } },
      orderBy: { eventId: 'asc' },
      select: { eventId: true, eventName: true, payload: true },
    });
    for (const event of events) {
      seenEventId = event.eventId;
      const elapsedMs = Date.now() - startedAt;
      timeline.push({ eventName: event.eventName, elapsedMs });
      log('event', {
        eventId: event.eventId,
        eventName: event.eventName,
        elapsedMs,
        detail: summarizePayload(event.payload),
      });
    }

    const task = await prisma.streamTask.findUniqueOrThrow({
      where: { id: context.taskId },
      select: {
        status: true,
        currentStep: true,
        errorMessage: true,
        temporalRunId: true,
      },
    });
    if (task.status !== lastStatus) {
      log('task.status', {
        status: task.status,
        currentStep: task.currentStep,
        elapsedMs: Date.now() - startedAt,
      });
      lastStatus = task.status;
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      return {
        preset: context.preset,
        status: task.status,
        errorMessage: task.errorMessage,
        currentStep: task.currentStep,
        approvals,
        timeline,
        durationMs: Date.now() - startedAt,
      };
    }
    if (task.status === 'WAITING_HUMAN') {
      await sleep(APPROVAL_SETTLE_MS);
      const submitted = await submitPendingApproval(
        prisma,
        streamTaskService,
        context,
      );
      if (submitted) {
        approvals += 1;
        log('approval.submitted', {
          approvalId: submitted.approvalId,
          kind: submitted.kind,
          round: approvals,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const stalled = await prisma.streamTask.findUniqueOrThrow({
    where: { id: context.taskId },
    select: { status: true, currentStep: true },
  });
  return {
    preset: context.preset,
    status: `TIMEOUT(${stalled.status})`,
    currentStep: stalled.currentStep,
    approvals,
    timeline,
    durationMs: Date.now() - startedAt,
    errorMessage: `观测超过 ${OBSERVE_TIMEOUT_MS / 1000}s 仍未进入终态`,
  };
}

/**
 * 用真实审批入口提交一次通过决定
 * @param prisma 已连接开发库的 Prisma 服务
 * @param streamTaskService 承载审批恢复逻辑的真实服务
 * @param context 任务 ID 与属主
 * @returns 返回已提交的审批标识；无待处理审批时返回 null
 * @description 走 StreamTaskService 的正式入口而非直接改库，这样审批的属主校验、决定闭集
 * 校验、trace 收敛与 outbox 写入都会被真实执行。
 */
async function submitPendingApproval(prisma, streamTaskService, context) {
  const approval = await prisma.agentFlowApproval.findFirst({
    where: { taskId: context.taskId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true },
  });
  if (!approval) {
    return null;
  }
  const task = await prisma.streamTask.findUniqueOrThrow({
    where: { id: context.taskId },
    select: { lastEventId: true },
  });
  const lastEventId = String(task.lastEventId ?? 0);

  if (approval.kind === 'PLAN_REVIEW') {
    const result = await streamTaskService.resumeTaskWithPlanReview(
      context.taskId,
      context.userId,
      { decision: 'approve' },
      lastEventId,
      undefined,
      approval.id,
    );
    drainStream(result);
  } else {
    const result = await streamTaskService.resumeTaskWithDecision(
      context.taskId,
      context.userId,
      { decision: 'approve' },
      lastEventId,
      undefined,
      approval.id,
    );
    drainStream(result);
  }
  return { approvalId: approval.id, kind: approval.kind };
}

/**
 * 后台消费审批恢复返回的流
 * @param result 审批入口返回的任务流结果
 * @returns 无返回值
 * @description 该流是活的 SSE 订阅，要等任务抵达终态才结束。绝不能 await：
 * 那会让观测循环停摆整个执行期，把所有后续事件挤成同一时刻，节点耗时全部失真。
 * 这里只做后台排空以释放订阅，推进过程仍由轮询观测。
 */
function drainStream(result) {
  const stream = result?.stream;
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    return;
  }
  void (async () => {
    try {
      for await (const _frame of stream) {
        void _frame;
      }
    } catch {
      // 恢复流在 Worker 接管后被关闭属于预期，不影响观测
    }
  })();
}

/**
 * 从事件载荷提取用于人工阅读的摘要
 * @param payload StreamTaskEvent.payload 的 JSON 值
 * @returns 返回精简后的对象；无可读字段时返回 undefined
 * @description 只取节点、状态、耗时与错误分类等定位字段，避免把完整回复正文刷进终端。
 */
function summarizePayload(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return undefined;
  }
  // 落库的是完整事件信封，业务字段在其 payload 键下，不在顶层
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const picked = {};
  for (const key of [
    'nodeKey',
    'nodeType',
    'publicStatus',
    'title',
    'summary',
    'durationMs',
    'category',
    'retryable',
    'stepCount',
    'revision',
    'deltaCount',
    'fullContentLength',
  ]) {
    if (payload[key] !== undefined) {
      picked[key] = payload[key];
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * 输出本次验证结论
 * @param outcome 观测阶段收集的时间线与终态
 * @returns 无返回值
 * @description 显式列出各节点事件是否出现，把"任务完成"与"目标链路真的执行过"区分开：
 * 只看终态会把跳过节点的 Flow 误判为通过。
 */
function reportOutcome(outcome) {
  const eventNames = new Set(outcome.timeline.map((entry) => entry.eventName));
  const nodeCompleted = outcome.timeline.filter(
    (entry) => entry.eventName === 'flow.node.completed',
  ).length;
  log('conclusion', {
    preset: outcome.preset,
    status: outcome.status,
    durationMs: outcome.durationMs,
    nodeCompletedCount: nodeCompleted,
    approvalRounds: outcome.approvals,
    // message.delta 是高频事件，按设计只进 Redis 缓冲不落库；模型是否真产出回复
    // 由 message.done 及其 content 判定，不能用 delta 是否落库来推断。
    sawMessageDone: eventNames.has('message.done'),
    sawWaitingHuman: eventNames.has('flow.waiting_human'),
    sawNodeFailed: eventNames.has('flow.node.failed'),
    // flow.run.started 语义上一个 run 应只发一次；多于 1 次即为按节点重复发送
    runStartedCount: outcome.timeline.filter(
      (entry) => entry.eventName === 'flow.run.started',
    ).length,
    currentStep: outcome.currentStep,
    errorMessage: outcome.errorMessage ?? undefined,
    nodeDurations: measureNodeDurations(outcome.timeline),
  });
}

/**
 * 由事件时间线还原各节点真实耗时
 * @param timeline 观测阶段按序记录的事件与相对耗时
 * @returns 返回每个 flow.node.completed 相对其 flow.node.started 的毫秒数
 * @description 事件载荷里的 durationMs 恒为 0，无法用于判断慢节点；这里用观测侧时间戳
 * 反算，以便定位逼近 Activity startToCloseTimeout 的节点。
 */
function measureNodeDurations(timeline) {
  const durations = [];
  let startedAt;
  for (const entry of timeline) {
    if (entry.eventName === 'flow.node.started') {
      startedAt = entry.elapsedMs;
      continue;
    }
    if (entry.eventName === 'flow.node.completed' && startedAt !== undefined) {
      durations.push({ observedMs: entry.elapsedMs - startedAt });
      startedAt = undefined;
    }
  }
  return durations;
}

/**
 * 删除本次验证创建的数据
 * @param prisma 已连接开发库的 Prisma 服务
 * @param fixture 创建阶段返回的实体 ID 集合
 * @returns 无返回值
 * @description 开发库里有真实数据，验证产物必须清掉。Agent 与 FlowVersion 存在外键引用，
 * 需先解绑指针再删除；删除失败只告警，不掩盖主流程结论。
 */
async function cleanupFixture(prisma, fixture) {
  try {
    // StreamTask 外键引用 FlowVersion，且不随会话级联删除，必须先于版本删除
    if (fixture.taskId) {
      await prisma.streamTask.deleteMany({ where: { id: fixture.taskId } });
    }
    if (fixture.conversationId) {
      await prisma.conversation.deleteMany({
        where: { id: fixture.conversationId },
      });
    }
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
  } catch (error) {
    log('fixture.cleanup.failed', {
      error: error instanceof Error ? error.message : String(error),
      hint: '残留数据带 debug-agent-flow 前缀，可手工删除',
    });
  }
}

/**
 * 延时
 * @param milliseconds 等待毫秒数
 * @returns 返回到期后 resolve 的 Promise
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 输出结构化调试日志
 * @param event 事件名后缀
 * @param payload 附加字段
 * @returns 无返回值
 * @description 与其他 debug 脚本一致走 stderr，便于把观测日志与被测输出分开重定向。
 */
function log(event, payload) {
  console.error(
    JSON.stringify({ event: `debug.agent-flow.${event}`, ...payload }),
  );
}

/**
 * 读取 .env 到 process.env
 * @param filePath .env 文件路径
 * @returns 无返回值
 * @description 已存在的环境变量优先，便于在命令行临时覆盖模型与开关。
 */
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[key] = value;
  }
}

main().catch((error) => {
  log('failed', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split('\n').slice(1, 4) : undefined,
  });
  process.exitCode = 1;
});
