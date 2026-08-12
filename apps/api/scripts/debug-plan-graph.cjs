/*
 * plan/hybrid 编排图冒烟脚本
 *
 * 目的：跑**生产代码本身**（dist 里的 PlanGraphRunner），而不是再搭一个形状相同的
 * 玩具图。debug-graph-events.cjs 验证的是机制可行，这里验证的是「我们写的这版实现
 * 真的能跑出正确的事件序列」——两者不能互相替代。
 *
 * 依赖注入用轻量替身，只为绕开 DB / Kimi：
 * - planner   固定两步计划（真规划要调 Kimi，本脚本不测规划质量）
 * - llmService 只需 createChatModel / resolveTextRequest 两个方法
 * - evaluator 固定不提前收尾（plan 模式本来也跑完所有步骤）
 * 图结构、事件发射、流解析、步骤隔离全部是真实生产代码。
 *
 * 两个场景：
 *
 * A. 无审批（行为等价性）
 *    1. 事件序列是否与迁移前的 controller 等价
 *       （agent.loop.start → step.start/done(create_plan) → 每步 start/done → synthesize）
 *    2. message.delta 是否**只**来自 synthesize（步骤过程文本必须被滤掉）
 *    3. 工具事件是否照常穿透（tool.call.start/delta/done）
 *
 * B. 带审批（HITL 覆盖 plan/hybrid，本迁移的头号价值主张）
 *    4. 首轮是否在工具执行前挂起并发出 approval.required（工具**未**执行）
 *    5. runner.resume() 能否从中断处续跑，工具真的被执行
 *    6. 多步计划里每个受审步骤各中断一次 → 能否承受多轮进出等待态
 *
 * 前置：pnpm --filter ./apps/api run build
 * 用法：node scripts/debug-plan-graph.cjs
 */
const fs = require('fs');
const path = require('path');
const { ChatOpenAICompletions } = require('@langchain/openai');
const { MemorySaver } = require('@langchain/langgraph');
const { tool } = require('@langchain/core/tools');
const { z } = require('zod');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);
loadDotEnv(path.resolve(backendRoot, '.env'));

const DIST = path.resolve(backendRoot, 'dist/src/modules/ai');
requireDist();
const {
  PlanGraphRunner,
} = require(`${DIST}/agent-loop/execution/plan-graph.runner`);
const {
  CommonChatAgentFactory,
} = require(`${DIST}/agents/common-chat-agent/common-chat-agent.factory`);

const model = process.env.OPENAI_MODEL || 'gpt-4.1';
const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;

let toolExecuted = false;
const weatherTool = tool(
  async (input) => {
    toolExecuted = true;
    return `天气查询结果：${input.city}，晴，28°C`;
  },
  {
    name: 'getWeather',
    description: '根据城市名称查询当前天气',
    schema: z.object({ city: z.string() }),
  },
);

// 生图桩：记录每次真实执行，用于排查「重复/提前调用」——需审批，故正常应在 approve 后才计数
let imageCallCount = 0;
const imageTool = tool(
  async () => {
    imageCallCount += 1;
    return `已生成图片：https://example.com/img-${imageCallCount}.png`;
  },
  {
    name: 'generateImage',
    description: '根据描述生成一张图片',
    schema: z.object({ prompt: z.string(), size: z.string().optional() }),
  },
);

async function main() {
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  const chat = new ChatOpenAICompletions({
    model,
    apiKey,
    configuration: { baseURL },
  });

  // 复现「planner 在节点内 invoke 模型」这条真实路径：真实 PlannerService 走的是
  // generateStructured → 节点内的一次模型调用，streamMode:'messages' 会捕获它的 token。
  // 若过滤没白名单 synthesize，planner 的这段 JSON 就会漏成正文（本次要验证的 bug）。
  const PLAN_PROBE = '__PLANNER_PROBE_SHOULD_NOT_LEAK__';
  const planner = {
    plan: async () => {
      // 强制模型吐出一段带哨兵串的文本，模拟 planner 的结构化输出
      await chat.invoke([
        new (require('@langchain/core/messages').SystemMessage)(
          `只输出这一行、不要任何多余内容：${PLAN_PROBE}`,
        ),
        new (require('@langchain/core/messages').HumanMessage)('开始'),
      ]);
      return {
        steps: [
          { id: 'step-1', goal: '查询深圳当前天气' },
          { id: 'step-2', goal: '根据天气给出穿衣建议' },
        ],
        fromModel: true,
      };
    },
  };
  const llmService = {
    createChatModel: () => chat,
    resolveTextRequest: (request) => request ?? {},
  };
  const evaluator = { enough: () => false };

  // 同一个 MemorySaver 实例：buildGraph 每次调用都要拿到同一份检查点，
  // 否则首轮存的状态在 resume 时读不到（生产里是进程单例的 PostgresSaver）
  const saver = new MemorySaver();
  const checkpointer = { get: () => saver };

  const runner = new PlanGraphRunner(
    planner,
    new CommonChatAgentFactory(),
    llmService,
    checkpointer,
    evaluator,
  );

  const baseInput = {
    messages: [
      { role: 'user', content: '深圳现在的天气怎么样？顺便说说适合穿什么。' },
    ],
    systemPrompt: '你是一个乐于助人的助手。',
    tools: [weatherTool],
    maxSteps: 6,
  };

  // ---- 场景 A：无审批，验证与迁移前行为等价 ----
  const runA = await drain(runner.stream(baseInput, 'plan_execute'));
  log('a.event-sequence', { sequence: runA.sequence });
  log('a.final-answer', {
    length: runA.answer.length,
    preview: runA.answer.slice(0, 120),
  });
  log('a.planner-leak-check', {
    // 核心断言：planner 在 create_plan 节点内 invoke 的输出**不能**出现在正文里
    plannerOutputLeaked: runA.answer.includes(PLAN_PROBE),
  });
  log('a.conclusion', {
    hasFinalAnswer: runA.answer.trim().length > 0,
    sawToolCall: runA.sequence.some((item) => item.startsWith('tool.call.done')),
    sawBothSteps:
      runA.sequence.some((item) => item.includes('#step-1')) &&
      runA.sequence.some((item) => item.includes('#step-2')),
    sawSynthesize: runA.sequence.some((item) => item.includes('#synthesize')),
    // 步骤过程文本必须被滤掉：delta 只应来自 synthesize
    deltaOnlyAfterSynthesize:
      runA.sequence.findIndex((item) => item.includes('#synthesize')) <
      runA.sequence.findIndex((item) => item.startsWith('message.delta')),
  });

  // ---- 场景 B：plan_execute 带审批工具的**组合流**（计划审批 → 逐步工具审批） ----
  // plan_execute + threadId 会先出计划审批，再在含审批工具的步骤各中断一次。
  // 按当前挂起的中断类型分发对应的 approve，直到跑完。
  toolExecuted = false;
  const hitlInput = {
    ...baseInput,
    threadId: 'debug-plan-graph-hitl-1',
    approvalToolNames: ['getWeather'],
  };

  const turn1 = await drain(runner.stream(hitlInput, 'plan_execute'));
  const firstIsPlanReview = turn1.planReviews.length > 0;
  log('b.turn1', {
    sequence: turn1.sequence,
    firstInterrupt: firstIsPlanReview ? 'plan.review' : 'approval',
    // 关键：任何工具在第一次审批前都**不能**执行
    toolExecutedBeforeAnyApproval: toolExecuted,
  });

  if (!firstIsPlanReview && turn1.approvals.length === 0) {
    log('b.conclusion', { result: 'NO_INTERRUPT' });
    return;
  }

  // 循环恢复：计划审批发 plan approve，工具审批发 tool approve；上限只为防死循环
  const rounds = [];
  let last = turn1;
  for (let i = 0; i < 6; i++) {
    const isPlan = last.planReviews.length > 0;
    const isTool = last.approvals.length > 0;
    if (!isPlan && !isTool) break;

    const round = await drain(
      runner.resume(hitlInput, 'plan_execute', { decision: 'approve' }),
    );
    rounds.push({
      round: rounds.length + 1,
      resumed: isPlan ? 'plan' : 'tool',
      answerLength: round.answer.length,
    });
    last = round;
  }

  log('b.resume-rounds', { rounds });
  log('b.conclusion', {
    result:
      toolExecuted && rounds.some((item) => item.answerLength > 0)
        ? 'PLAN_HITL_OK'
        : 'RESUME_INCOMPLETE',
    resumeRounds: rounds.length,
    firstResumedPlan: rounds[0]?.resumed === 'plan',
    toolExecutedAfterApproval: toolExecuted,
  });

  // ---- 场景 C：计划审批（plan_execute 默认开），验证四种决定 ----
  // 不带 approvalToolNames：只测计划审批，避免工具中断混入。计划审批由 threadId 触发。
  const planInput = (thread) => ({ ...baseInput, threadId: thread });

  // C1 approve：首轮出计划并中断，approve 后跑完
  const c1First = await drain(runner.stream(planInput('pg-plan-approve'), 'plan_execute'));
  const c1Resume = c1First.planReviews.length
    ? await drain(
        runner.resume(planInput('pg-plan-approve'), 'plan_execute', {
          decision: 'approve',
        }),
      )
    : { answer: '', sequence: [] };
  log('c1.approve', {
    firstStepExecutedBeforeReview: c1First.sequence.some((i) =>
      i.startsWith('tool.call'),
    ),
    planReview: c1First.planReviews[0],
    resumedToAnswer: c1Resume.answer.trim().length > 0,
  });

  // C2 edit：改文字 + 追加一步，用改后计划执行
  const c2First = await drain(runner.stream(planInput('pg-plan-edit'), 'plan_execute'));
  const c2Resume = c2First.planReviews.length
    ? await drain(
        runner.resume(planInput('pg-plan-edit'), 'plan_execute', {
          decision: 'edit',
          editedSteps: [
            { goal: '查询深圳今天的天气（改）' },
            { goal: '给出穿衣建议（改）' },
            { goal: '追加：补充一句防晒提醒' },
          ],
        }),
      )
    : { answer: '', sequence: [] };
  log('c2.edit', {
    editedStepsRan: c2Resume.sequence.filter((i) =>
      i.startsWith('workflow.step.start#step-'),
    ),
    resumedToAnswer: c2Resume.answer.trim().length > 0,
  });

  // C3 reject_replan：带意见打回 → create_plan 重跑 → 新一轮计划审批（revision+1）
  const c3First = await drain(runner.stream(planInput('pg-plan-replan'), 'plan_execute'));
  const c3Replan = c3First.planReviews.length
    ? await drain(
        runner.resume(planInput('pg-plan-replan'), 'plan_execute', {
          decision: 'reject_replan',
          feedback: '太复杂了，请合并成两步',
        }),
      )
    : { planReviews: [] };
  log('c3.reject_replan', {
    firstRevision: c3First.planReviews[0]?.revision,
    replanReemittedReview: c3Replan.planReviews.length > 0,
    secondRevision: c3Replan.planReviews[0]?.revision,
  });

  // C4 reject_terminate：终止 → 无 synthesize，收到固定终止文案
  const c4First = await drain(runner.stream(planInput('pg-plan-terminate'), 'plan_execute'));
  const c4Term = c4First.planReviews.length
    ? await drain(
        runner.resume(planInput('pg-plan-terminate'), 'plan_execute', {
          decision: 'reject_terminate',
        }),
      )
    : { answer: '', sequence: [] };
  log('c4.reject_terminate', {
    terminationAnswer: c4Term.answer,
    sawSynthesize: c4Term.sequence.some((i) => i.includes('#synthesize')),
  });

  log('c.conclusion', {
    result:
      c1First.planReviews.length &&
      c1Resume.answer.trim().length > 0 &&
      c2Resume.answer.trim().length > 0 &&
      c3Replan.planReviews.length > 0 &&
      c4Term.answer.includes('终止') &&
      !c4Term.sequence.some((i) => i.includes('#synthesize'))
        ? 'PLAN_REVIEW_OK'
        : 'PLAN_REVIEW_INCOMPLETE',
  });

  // ---- 场景 D：复现生产「generateImage 重复/提前调用」 ----
  // 生产形状：执行器同时带 getWeather + generateImage，只有 generateImage 需审批，
  // 计划审批 + 工具审批都开。3 步计划（查天气 / 出行建议 / 生成图），观察 generateImage
  // 到底在**哪一步**、被调**几次**——据此判断是「早调（工具没按步限制）」还是「同一步多调」。
  imageCallCount = 0;
  const dInput = {
    messages: [
      {
        role: 'user',
        content: '查一下深圳今天的天气，给出出行建议，并生成一张出行建议图',
      },
    ],
    systemPrompt: '你是一个乐于助人的助手。',
    tools: [weatherTool, imageTool],
    maxSteps: 6,
    threadId: 'pg-repro-image',
    approvalToolNames: ['generateImage'],
  };
  const dPlanner = {
    plan: async () => ({
      steps: [
        {
          id: 'step-1',
          goal: '查询今天深圳的天气情况',
          suggestedTools: ['getWeather'],
        },
        { id: 'step-2', goal: '根据天气给出出行建议', suggestedTools: [] },
        {
          id: 'step-3',
          goal: '生成一张出行建议图',
          suggestedTools: ['generateImage'],
        },
      ],
      fromModel: true,
    }),
  };
  const dRunner = new PlanGraphRunner(
    dPlanner,
    new CommonChatAgentFactory(),
    llmService,
    checkpointer,
    evaluator,
  );

  // 记录每次 generateImage 审批发生在「哪个 step 已 start、尚未 done」的窗口
  const imageApprovalSteps = [];
  const trackImageApproval = (round) => {
    // 从本轮序列里找最后一个 step.start，作为该审批所属步骤
    const starts = round.sequence.filter((i) =>
      i.startsWith('workflow.step.start#step-'),
    );
    if (round.approvals.some((a) => a.toolName === 'generateImage')) {
      imageApprovalSteps.push(starts[starts.length - 1] ?? '(未知步骤)');
    }
  };

  let dLast = await drain(dRunner.stream(dInput, 'plan_execute'));
  const fullSeq = [...dLast.sequence];
  trackImageApproval(dLast);
  for (let i = 0; i < 8; i++) {
    const isPlan = dLast.planReviews.length > 0;
    const isTool = dLast.approvals.length > 0;
    if (!isPlan && !isTool) break;
    dLast = await drain(
      dRunner.resume(dInput, 'plan_execute', { decision: 'approve' }),
    );
    fullSeq.push(...dLast.sequence);
    trackImageApproval(dLast);
  }

  log('d.full-sequence', { sequence: fullSeq });
  log('d.image-diagnosis', {
    imageApprovalCount: imageApprovalSteps.length,
    imageApprovalSteps,
    imageExecutedCount: imageCallCount,
    // 期望：generateImage 只在 step-3 审批 1 次、执行 1 次
    verdict:
      imageApprovalSteps.length === 1 &&
      imageApprovalSteps[0]?.includes('step-3') &&
      imageCallCount === 1
        ? 'OK_SINGLE_IMAGE_IN_STEP3'
        : 'BUG_IMAGE_MISCALLED',
  });
}

/** 消费事件流，归类出序列、审批请求、计划审批与最终文本 */
async function drain(events) {
  const sequence = [];
  const approvals = [];
  const planReviews = [];
  let answer = '';

  for await (const event of events) {
    if (event.type === 'message.delta') {
      answer += event.delta;
      pushCollapsed(sequence, 'message.delta');
      continue;
    }
    if (event.type === 'tool.call.delta') {
      pushCollapsed(sequence, 'tool.call.delta');
      continue;
    }
    if (event.type === 'approval.required') {
      approvals.push({
        toolName: event.payload.toolName,
        args: event.payload.args,
        nodeKey: event.payload.nodeKey,
        allowedDecisions: event.payload.allowedDecisions,
      });
    }
    if (event.type === 'plan.review.required') {
      planReviews.push({
        steps: event.payload.steps.map((s) => s.goal),
        revision: event.payload.revision,
        nodeKey: event.payload.nodeKey,
        allowedDecisions: event.payload.allowedDecisions,
      });
    }
    const step = event.payload && event.payload.step;
    pushCollapsed(sequence, step ? `${event.type}#${step}` : event.type);
  }

  return { sequence, approvals, planReviews, answer };
}

/** 折叠连续同类事件，便于一眼比对序列 */
function pushCollapsed(list, label) {
  const last = list[list.length - 1];
  if (last && last.replace(/ x\d+$/, '') === label) {
    const count = Number((last.match(/ x(\d+)$/) || [, 1])[1]) + 1;
    list[list.length - 1] = `${label} x${count}`;
    return;
  }
  list.push(label);
}

function requireDist() {
  if (!fs.existsSync(DIST)) {
    throw new Error(
      '缺少 dist，请先执行：pnpm --filter ./apps/api run build',
    );
  }
}

function log(event, payload) {
  console.error(
    JSON.stringify({ event: `debug.plan-graph.${event}`, ...payload }),
  );
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const raw = trimmed.slice(index + 1).trim();
    const value = raw.replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

main().catch((error) => {
  console.error('debug-plan-graph failed:', error);
  process.exit(1);
});
