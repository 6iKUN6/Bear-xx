/*
 * 图事件桥接诊断脚本
 *
 * 目的：验证「plan/hybrid 迁 StateGraph」的第二个技术前提——
 * 编排事件（workflow.step.* / agent.loop.start / model.call.*）怎么从图里发出来。
 *
 * 现有实现是 controller 手写 `yield`，语义精确（中文 publicStatus、traceKey、nodeKey
 * 都是刻意设计，前端 streamFeedback 与 conversation-trace.mapper 都依赖）。
 * 图节点里没有 yield，streamMode:'messages' 也拿不到节点边界，所以要么用 updates 反推，
 * 要么用 custom + writer() 让节点直接推出成品事件。方案选后者，本脚本验证它成立。
 *
 * 图形状沿用 debug-subgraph-interrupt.cjs（两步计划 + 条件边回环 + 内层 ReAct 子图），
 * 差别只是每个节点内加了 writer()，且消费侧改成多模式 + subgraphs。
 *
 * 已验证的结论（迁移方案据此设计）：
 *
 * Q0 **顶层导出的 `writer(chunk)` 是静默失效的**：在节点里调用不抛错，
 *    但一个 custom 块都产不出。必须用 `config.writer(chunk)`（节点第二参），
 *    或 `getWriter()`（环境上下文，外层节点内可用）。
 *    这条只能实测——类型签名完全正常，编译期与运行期都不会报错。
 *
 * Q1 多模式 + subgraphs 的块确为 3 元组 `[namespace, mode, payload]`。
 *    注意 custom 与 messages 的**命名空间规则不同**：
 *      custom   → 恒为 `[]`（root），发自哪个节点看不出来
 *      messages → 外层节点 1 段（`prepare_step:uuid`）、子图内 2 段
 *    所以编排事件的归属信息必须写在载荷里（nodeKey / step），不能靠命名空间推。
 *    区分「步骤过程文本」与「最终答案」仍按 messages 的段数：
 *    `execute(2)` 是子图内步骤推理，`synthesize(1)` 是最终答案。
 *
 * Q2 顺序正确且稳定。实测序列：
 *      step.start#step-1 → prepare_step 的 system/human → execute 的 ai 块
 *      model.call.start → synthesize 的 ai 块 → model.call.done → step.done
 *    编排事件始终落在对应 messages 之前/之后，前端卡片不会先出内容后出标题。
 *
 * Q3 **custom 不重放**。turn1 发过 create_plan 的三条 + step-1 的 start；
 *    resume 轮只发 step-1 的 done 与 step-2 的 start，无一重复。
 *    即中断节点之前的节点不会重跑，前端不会出现重复步骤卡片——
 *    这是迁移最大的未知风险，至此清除。
 *
 * Q4 子图**内层**（工具执行上下文）`getWriter()` 拿不到 writer，写不出 custom。
 *    生产不依赖这条：工具事件走 messages 流（ToolMessage → tool.call.done），
 *    编排事件只从外层节点发。若将来确需内层自定义事件，再验证工具的 config 参数。
 *
 * 用法：node scripts/debug-graph-events.cjs
 */
const fs = require('fs');
const path = require('path');
const { createAgent, humanInTheLoopMiddleware } = require('langchain');
const {
  StateGraph,
  Annotation,
  MessagesAnnotation,
  MemorySaver,
  Command,
  getWriter,
  START,
  END,
} = require('@langchain/langgraph');
const { ChatOpenAICompletions } = require('@langchain/openai');
const { tool } = require('@langchain/core/tools');
const {
  RemoveMessage,
  SystemMessage,
  HumanMessage,
} = require('@langchain/core/messages');
const { REMOVE_ALL_MESSAGES } = require('@langchain/langgraph');
const { z } = require('zod');

const backendRoot = path.resolve(__dirname, '..');
process.chdir(backendRoot);
loadDotEnv(path.resolve(backendRoot, '.env'));

const model = process.env.OPENAI_MODEL || 'gpt-4.1';
const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;
const THREAD_ID = 'debug-graph-events-1';
const USER_INPUT = '深圳现在的天气怎么样？顺便说说适合穿什么。';

/**
 * 发一个编排事件
 * @description 形状对齐生产的 AgentLoopStreamEvent（type + payload），
 * 迁移后节点里就是这么写——载荷由 @litter-bear/types/protocol 的 createStreamEvent 约束。
 *
 * ⚠️ 必须走 `config.writer`。`@langchain/langgraph` 顶层导出的 `writer(chunk)`
 * 在节点里调用**不抛错也不产出任何块**（静默失效，实测得出，见文件头 Q0）。
 */
function emit(config, type, payload) {
  config.writer({ type, payload });
}

const weatherTool = tool(
  async (input) => {
    // Q4：从**子图内层**（工具执行上下文）发 custom，看命名空间是几段。
    // 若与外层节点无法区分，编排层就没法判断一个事件该不该下发给用户。
    // 这里刻意用 getWriter() 而非 config.writer：顺带验证环境上下文能否穿透到子图内层。
    const write = getWriter();
    if (typeof write === 'function') {
      write({ type: 'debug.inner.probe', payload: { from: 'tool', city: input.city } });
    }
    return `天气查询结果：${input.city}，晴，28°C`;
  },
  {
    name: 'getWeather',
    description: '根据城市名称查询当前天气',
    schema: z.object({ city: z.string() }),
  },
);

const StateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  plan: Annotation({ reducer: (_prev, next) => next, default: () => [] }),
  stepIndex: Annotation({ reducer: (_prev, next) => next, default: () => 0 }),
  observations: Annotation({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

function resetStepMessages(stepPrompt) {
  return [
    new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
    new SystemMessage(stepPrompt),
    new HumanMessage(USER_INPUT),
  ];
}

/**
 * 消费多模式流并记录**有序**轨迹
 * @description 顺序是本脚本的核心产出：Q2/Q3 都只能从序列里读出来，聚合计数会把它抹掉。
 */
async function drain(stream, trace) {
  let shape;
  for await (const chunk of stream) {
    if (!shape) {
      shape = {
        len: chunk.length,
        e0: Array.isArray(chunk[0]) ? `array:${JSON.stringify(chunk[0])}` : typeof chunk[0],
        e1: typeof chunk[1] === 'string' ? `string:${chunk[1]}` : typeof chunk[1],
        e2IsArray: Array.isArray(chunk[2]),
      };
    }

    // 期望 [namespace, mode, payload]；若不是 3 元组则如实记录，Q1 就此判负
    const isTriple = chunk.length === 3 && Array.isArray(chunk[0]);
    const namespace = isTriple ? chunk[0] : [];
    const mode = isTriple ? chunk[1] : '(unknown)';
    const payload = isTriple ? chunk[2] : chunk;

    trace.push({
      i: trace.length,
      ns: namespace.join('/') || '(root)',
      // 命名空间带任务后缀（execute:uuid），首段去掉后缀才是节点名
      nsHead: (namespace[0] || '').split(':')[0] || '(root)',
      nsDepth: namespace.length,
      mode,
      kind: describe(mode, payload),
    });
  }
  return shape;
}

/**
 * 提取块的可读种类：custom 取事件 type（带 step 后缀），messages 取消息类型
 * @description step 后缀是 Q3 的判据来源——只有带上它，才能把「create_plan 的
 * step.done 重放了」和「collect_step 正常发 step.done」区分开。
 */
function describe(mode, payload) {
  if (mode === 'custom') {
    if (!payload || !payload.type) return '(no-type)';
    const step = payload.payload && payload.payload.step;
    return step ? `${payload.type}#${step}` : payload.type;
  }
  if (mode === 'messages') {
    const message = Array.isArray(payload) ? payload[0] : undefined;
    return message && message.getType ? `msg:${message.getType()}` : 'msg:?';
  }
  return `${mode}:?`;
}

async function main() {
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  const chat = new ChatOpenAICompletions({
    model,
    apiKey,
    configuration: { baseURL },
  });

  // 内层与生产一致：createAgent + HITL 中间件，且不带 checkpointer（由外层提供）
  const innerAgent = createAgent({
    model: chat,
    tools: [weatherTool],
    middleware: [
      humanInTheLoopMiddleware({
        interruptOn: {
          getWeather: {
            allowedDecisions: ['approve', 'edit', 'reject'],
            description: '请确认是否执行工具「getWeather」',
          },
        },
      }),
    ],
    name: 'inner-react',
  });

  const graph = new StateGraph(StateAnnotation)
    .addNode('create_plan', (_state, config) => {
      emit(config, 'agent.loop.start', { nodeKey: 'agent_loop_controller' });
      emit(config, 'workflow.step.start', {
        step: 'create_plan',
        nodeKey: 'create_plan',
      });
      const plan = ['查询深圳天气', '根据天气给穿衣建议'];
      emit(config, 'workflow.step.done', {
        step: 'create_plan',
        stepCount: plan.length,
      });
      return { plan, stepIndex: 0 };
    })
    .addNode('prepare_step', (state, config) => {
      // Q2 的关键发射点：这一条必须先于本步 execute 子图里的任何 messages 块
      emit(config, 'workflow.step.start', {
        step: `step-${state.stepIndex + 1}`,
        title: state.plan[state.stepIndex],
      });
      return {
        messages: resetStepMessages(
          `只专注完成当前步骤：${state.plan[state.stepIndex]}。` +
            (state.observations.length
              ? `\n已有信息：${state.observations.join(' / ')}`
              : ''),
        ),
      };
    })
    .addNode('execute', innerAgent.graph)
    .addNode('collect_step', (state, config) => {
      const lastAi = [...state.messages]
        .reverse()
        .find((m) => m.getType && m.getType() === 'ai');
      const text = lastAi && typeof lastAi.content === 'string' ? lastAi.content : '';
      emit(config, 'workflow.step.done', { step: `step-${state.stepIndex + 1}` });
      return { observations: [text.slice(0, 80)], stepIndex: state.stepIndex + 1 };
    })
    .addNode('synthesize', async (state, config) => {
      emit(config, 'workflow.step.start', { step: 'synthesize' });
      emit(config, 'model.call.start', { nodeKey: 'synthesize_model' });
      const res = await chat.invoke([
        new SystemMessage('基于已有信息给出最终回答，不要提及内部步骤。'),
        new HumanMessage(`${USER_INPUT}\n已收集：${state.observations.join(' / ')}`),
      ]);
      emit(config, 'model.call.done', { nodeKey: 'synthesize_model' });
      emit(config, 'workflow.step.done', { step: 'synthesize' });
      return { messages: [res] };
    })
    .addEdge(START, 'create_plan')
    .addEdge('create_plan', 'prepare_step')
    .addEdge('prepare_step', 'execute')
    .addEdge('execute', 'collect_step')
    .addConditionalEdges('collect_step', (state) =>
      state.stepIndex < state.plan.length ? 'prepare_step' : 'synthesize',
    )
    .addEdge('synthesize', END)
    .compile({ checkpointer: new MemorySaver() });

  const config = {
    // 迁移后生产要用的形状：编排事件走 custom，模型/工具走 messages
    streamMode: ['messages', 'custom'],
    subgraphs: true,
    configurable: { thread_id: THREAD_ID },
  };

  // ---- turn1：期望在子图内中断 ----
  const turn1 = [];
  const shape = await drain(
    await graph.stream({ messages: [new HumanMessage(USER_INPUT)] }, config),
    turn1,
  );
  log('q1-chunk-shape', { shape, expected: '[namespace, mode, payload] → len=3' });
  log('turn1-trace', { count: turn1.length, trace: compact(turn1) });

  // ---- Q2：custom 与 messages 的相对顺序 ----
  const firstStepStart = turn1.find(
    (e) => e.mode === 'custom' && e.kind === 'workflow.step.start#step-1',
  );
  const firstExecuteMessage = turn1.find(
    (e) => e.mode === 'messages' && e.nsHead === 'execute',
  );
  log('q2-ordering', {
    step1StartAt: firstStepStart ? firstStepStart.i : null,
    step1StartNs: firstStepStart ? `${firstStepStart.nsHead}(${firstStepStart.nsDepth})` : null,
    firstExecuteMessageAt: firstExecuteMessage ? firstExecuteMessage.i : null,
    stepStartBeforeStepMessages:
      firstStepStart && firstExecuteMessage
        ? firstStepStart.i < firstExecuteMessage.i
        : null,
  });

  // ---- Q4：内层 writer 的命名空间 ----
  // turn1 会在工具执行前中断，故探针要到 resume 后才出现，这里先看外层的深度基线
  log('q4-namespace-baseline', {
    rootCustomDepths: uniq(
      turn1.filter((e) => e.mode === 'custom').map((e) => `${e.nsHead}(${e.nsDepth})`),
    ),
  });

  const state = await graph.getState(config);
  const interrupts = (state.tasks || []).flatMap((t) => t.interrupts || []);
  if (interrupts.length === 0) {
    log('conclusion', { result: 'NO_INTERRUPT', meaning: '未触发中断，Q3 无法验证' });
    return;
  }

  // ---- resume：Q3 的核心。每步各中断一次，故循环恢复直到无挂起 ----
  const rounds = [];
  for (let i = 0; i < 5; i++) {
    const pending = await graph.getState(config);
    if (!(pending.tasks || []).some((t) => (t.interrupts || []).length > 0)) break;

    const round = [];
    await drain(
      await graph.stream(
        new Command({ resume: { decisions: [{ type: 'approve' }] } }),
        config,
      ),
      round,
    );
    rounds.push(round);
    log(`resume-${rounds.length}-trace`, { count: round.length, trace: compact(round) });
  }

  // ---- Q3：custom 是否重放 ----
  // 判据：turn1 已发过的编排事件，不应在任何 resume 轮里再次出现同一个。
  // create_plan 只在首轮跑，它的事件若重现即为重放。
  const turn1Custom = customKinds(turn1);
  const seen = new Set(turn1Custom);
  const replayed = rounds.map((round, index) => {
    const custom = customKinds(round);
    const dup = custom.filter((k) => seen.has(k));
    custom.forEach((k) => seen.add(k));
    return { round: index + 1, custom, replayedFromEarlierRounds: dup };
  });
  log('q3-replay', {
    turn1Custom,
    rounds: replayed,
    anyReplay: replayed.some((r) => r.replayedFromEarlierRounds.length > 0),
  });

  // ---- Q4：resume 后工具真的执行了，探针块的命名空间可读 ----
  const probes = rounds
    .flat()
    .filter((e) => e.mode === 'custom' && e.kind === 'debug.inner.probe');
  log('q4-inner-writer', {
    probeCount: probes.length,
    namespaces: uniq(probes.map((e) => `${e.ns} (depth=${e.nsDepth})`)),
  });

  const finalState = await graph.getState(config);
  log('conclusion', {
    next: finalState.next,
    stepIndex: finalState.values && finalState.values.stepIndex,
    observations: finalState.values && finalState.values.observations,
  });
}

/**
 * 压成 "i:ns|mode|kind" 并折叠连续同类块
 * @description 一次回答有上百个 message.delta，不折叠就淹掉编排事件；
 * 而 Q2/Q3 要看的恰恰是编排事件夹在哪两段 messages 之间，顺序必须保留。
 */
function compact(trace) {
  const out = [];
  for (const e of trace) {
    const label = `${e.nsHead}(${e.nsDepth})|${e.mode}|${e.kind}`;
    const last = out[out.length - 1];
    if (last && last.label === label) {
      last.count += 1;
      continue;
    }
    out.push({ at: e.i, label, count: 1 });
  }
  return out.map((e) => (e.count > 1 ? `${e.at}:${e.label} x${e.count}` : `${e.at}:${e.label}`));
}

function customKinds(trace) {
  return trace
    .filter((e) => e.mode === 'custom')
    .map((e) => e.kind);
}

function uniq(list) {
  return Array.from(new Set(list));
}

function log(event, payload) {
  console.error(JSON.stringify({ event: `debug.graph-events.${event}`, ...payload }));
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
  console.error('debug-graph-events failed:', error);
  process.exit(1);
});
