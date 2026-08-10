/*
 * 子图中断穿透诊断脚本
 *
 * 目的：验证「plan/hybrid 迁 StateGraph」的技术前提——
 * 把 createAgent() 的编译图作为节点嵌进外层 StateGraph 后，
 * 内层 HITL 中断能否穿透到外层，并能从外层 Command({resume}) 续跑。
 *
 * 这是迁移的成败关键：若中断不穿透，外层 checkpointer 就托管不了编排状态，
 * 「让 plan/hybrid 支持审批」这个头号价值主张就不成立，方案需要推倒重来。
 *
 * 外层图：create_plan -> execute(子图=ReAct agent) -> synthesize
 * 内层 agent 刻意不带 checkpointer，由外层提供，否则各存各的、无法联动。
 *
 * 已验证的结论（迁移方案据此设计）：
 * 1. 内层 HITL 中断能穿透：外层 getState() 读得到 actionRequests，next 停在子图节点
 * 2. 外层 Command({resume}) 能续跑内层并走完后续节点
 * 3. createAgent() 返回的 ReactAgent 是门面对象、不是 Runnable 子类，
 *    必须用 .graph 才能当节点
 * 4. 外层 streamMode:'messages' + subgraphs:true 拿得到子图内部消息块，
 *    形状 [命名空间, [message, metadata]]，内层元组与 mapMessagesStream 现有格式一致
 * 5. 命名空间首段即可区分来源，无需读 metadata：
 *      execute:*_/model_request:*  ai    内层步骤推理  -> 收集为观察
 *      execute:*_/tools:*          tool  工具结果      -> tool.call.done
 *      synthesize:*                ai    最终答案      -> message.delta
 *    外层节点直接调模型是**单段**命名空间，子图是**两段**。
 *
 * 用法：node scripts/debug-subgraph-interrupt.cjs
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
const THREAD_ID = 'debug-subgraph-1';

let toolExecuted = false;
const weatherTool = tool(
  async (input) => {
    toolExecuted = true;
    console.log('[tool executed] getWeather', input);
    return `天气查询结果：${input.city}，晴，28°C`;
  },
  {
    name: 'getWeather',
    description: '根据城市名称查询当前天气',
    schema: z.object({ city: z.string() }),
  },
);

/** 外层编排状态：messages 复用官方 reducer，其余是 plan/hybrid 需要的编排字段 */
const StateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  plan: Annotation({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  stepIndex: Annotation({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  observations: Annotation({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  nodeTrace: Annotation({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

/**
 * 重置 messages 为「原始对话 + 本步提示词」
 * @description 生产里每步只带 observations 文本、不看彼此的原始消息（步骤隔离，
 * 也控住 token）。用 RemoveMessage(REMOVE_ALL_MESSAGES) 清空再填，
 * 否则 MessagesAnnotation 的 reducer 只会累加。
 */
function resetStepMessages(userInput, stepPrompt) {
  return [
    new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
    new SystemMessage(stepPrompt),
    new HumanMessage(userInput),
  ];
}

/**
 * 消费流并归类块的形状
 * @description 关键在于确认外层图的 messages 模式能否拿到**子图内部**的消息块。
 * 能拿到，生产代码里的 mapMessagesStream 就能原样复用，事件桥接工作量骤降。
 */
async function drain(stream) {
  const kinds = new Map();
  let sampled = false;
  for await (const chunk of stream) {
    if (!sampled && Array.isArray(chunk)) {
      sampled = true;
      console.error(
        JSON.stringify({
          event: 'debug.subgraph.chunk-shape',
          len: chunk.length,
          e0: Array.isArray(chunk[0]) ? `array:${JSON.stringify(chunk[0])}` : typeof chunk[0],
          e1IsArray: Array.isArray(chunk[1]),
          e1Len: Array.isArray(chunk[1]) ? chunk[1].length : undefined,
          innerType:
            Array.isArray(chunk[1]) && chunk[1][0]?.getType
              ? chunk[1][0].getType()
              : undefined,
          innerMeta:
            Array.isArray(chunk[1]) && chunk[1][1]
              ? Object.keys(chunk[1][1]).slice(0, 8)
              : undefined,
        }),
      );
    }
    const ns = Array.isArray(chunk) && Array.isArray(chunk[0]) ? chunk[0].join('/') || '(root)' : '?';
    const inner = Array.isArray(chunk) && Array.isArray(chunk[1]) ? chunk[1][0] : undefined;
    const kind = `${ns} → ${inner?.getType ? inner.getType() : typeof inner}`;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  return Object.fromEntries(kinds);
}

async function main() {
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  const chat = new ChatOpenAICompletions({
    model,
    apiKey,
    configuration: { baseURL },
  });

  // 内层：与生产一致的 createAgent + HITL 中间件，但**不传 checkpointer**
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

  const USER_INPUT = '深圳现在的天气怎么样？顺便说说适合穿什么。';

  // 生产真实形状：多步循环 + 每步重置 messages + 条件边回环。
  // 单步跑通不代表循环跑通，中断发生在第 N 步时状态推进是否正确必须实测。
  const graph = new StateGraph(StateAnnotation)
    // 节点名不能与状态字段重名（LangGraph 会直接报错），故用 create_plan，
    // 正好与生产代码 STEP_TITLES 里的 key 一致
    .addNode('create_plan', () => ({
      plan: ['查询深圳天气', '根据天气给穿衣建议'],
      stepIndex: 0,
      nodeTrace: ['create_plan'],
    }))
    // 每步进子图前重置上下文：内层 agent 不带固定 systemPrompt，
    // 本步提示词作为 SystemMessage 注入
    .addNode('prepare_step', (state) => ({
      messages: resetStepMessages(
        USER_INPUT,
        `只专注完成当前步骤：${state.plan[state.stepIndex]}。` +
          (state.observations.length
            ? `\n已有信息：${state.observations.join(' / ')}`
            : ''),
      ),
      nodeTrace: [`prepare_step:${state.stepIndex}`],
    }))
    // createAgent 返回的 ReactAgent 是门面对象（有 invoke/stream 但不是 Runnable
    // 子类），直接当节点会被 _coerceToRunnable 拒绝。真正的编译图在 .graph 上。
    .addNode('execute', innerAgent.graph)
    // 收集本步产出为观察，推进步骤指针
    .addNode('collect_step', (state) => {
      const lastAi = [...state.messages]
        .reverse()
        .find((m) => m.getType && m.getType() === 'ai');
      const text =
        lastAi && typeof lastAi.content === 'string' ? lastAi.content : '';
      return {
        observations: [text.slice(0, 80)],
        stepIndex: state.stepIndex + 1,
        nodeTrace: [`collect_step:${state.stepIndex}`],
      };
    })
    .addNode('synthesize', async (state) => {
      const res = await chat.invoke([
        new SystemMessage('基于已有信息给出最终回答，不要提及内部步骤。'),
        new HumanMessage(
          `${USER_INPUT}\n已收集：${state.observations.join(' / ')}`,
        ),
      ]);
      return { nodeTrace: ['synthesize'], messages: [res] };
    })
    .addEdge(START, 'create_plan')
    .addEdge('create_plan', 'prepare_step')
    .addEdge('prepare_step', 'execute')
    .addEdge('execute', 'collect_step')
    // 条件边：还有步骤就回到 prepare_step，否则收尾
    .addConditionalEdges('collect_step', (state) =>
      state.stepIndex < state.plan.length ? 'prepare_step' : 'synthesize',
    )
    .addEdge('synthesize', END)
    .compile({ checkpointer: new MemorySaver() });

  // subgraphs: true 才能拿到子图内部的流；不加只有外层节点的产出
  const config = {
    streamMode: 'messages',
    subgraphs: true,
    configurable: { thread_id: THREAD_ID },
  };

  // ---- turn1：期望在子图内中断，synthesize 不应执行 ----
  const turn1Chunks = await drain(
    await graph.stream(
      { messages: [new HumanMessage(USER_INPUT)] },
      config,
    ),
  );
  log('turn1-chunks', turn1Chunks);

  const state = await graph.getState(config);
  const interrupts = (state.tasks || []).flatMap((t) => t.interrupts || []);
  const value = interrupts[0] && interrupts[0].value;

  log('after-turn1', {
    toolExecuted,
    interruptVisibleFromParent: interrupts.length > 0,
    next: state.next,
    nodeTrace: state.values && state.values.nodeTrace,
    actionRequests: value && value.actionRequests,
  });

  if (interrupts.length === 0) {
    log('conclusion', {
      result: 'NO_INTERRUPT_PROPAGATION',
      meaning: '中断没有穿透到外层，迁移方案不成立，需换方案',
    });
    return;
  }

  // ---- resume：从**外层图**恢复，验证内层工具真的被执行 ----
  // 多步计划里每个调用受审批工具的步骤都会各中断一次，故要循环恢复直到无挂起。
  // 上限只为防死循环——生产侧同理，必须能承受同一任务多轮 WAITING_HUMAN。
  const MAX_RESUMES = 5;
  let resumeRounds = 0;
  let resumeChunks = {};
  for (let i = 0; i < MAX_RESUMES; i++) {
    const pending = await graph.getState(config);
    const stillPaused = (pending.tasks || []).some(
      (t) => (t.interrupts || []).length > 0,
    );
    if (!stillPaused) break;

    resumeRounds += 1;
    resumeChunks = await drain(
      await graph.stream(
        new Command({ resume: { decisions: [{ type: 'approve' }] } }),
        config,
      ),
    );
  }
  log('resume-rounds', { resumeRounds, lastRoundChunks: resumeChunks });

  const finalState = await graph.getState(config);
  const messages = (finalState.values && finalState.values.messages) || [];
  const lastAi = [...messages]
    .reverse()
    .find((m) => m.getType && m.getType() === 'ai');

  log('conclusion', {
    result:
      toolExecuted && (finalState.values.nodeTrace || []).includes('synthesize')
        ? 'SUBGRAPH_INTERRUPT_OK'
        : 'RESUME_INCOMPLETE',
    toolExecutedAfterResume: toolExecuted,
    nodeTrace: finalState.values && finalState.values.nodeTrace,
    next: finalState.next,
    finalPreview:
      lastAi && typeof lastAi.content === 'string'
        ? lastAi.content.slice(0, 120)
        : '',
  });
}

function log(event, payload) {
  console.error(
    JSON.stringify({ event: `debug.subgraph.${event}`, ...payload }),
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
  console.error('debug-subgraph-interrupt failed:', error);
  process.exit(1);
});
