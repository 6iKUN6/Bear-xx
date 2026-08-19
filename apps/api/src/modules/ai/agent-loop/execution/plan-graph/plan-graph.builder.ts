import { Inject, Injectable } from '@nestjs/common';
import {
  Annotation,
  Command,
  MessagesAnnotation,
  REMOVE_ALL_MESSAGES,
  StateGraph,
  START,
  END,
  interrupt,
  type LangGraphRunnableConfig,
  type StreamMode,
} from '@langchain/langgraph';
import {
  RemoveMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type {
  ApprovalDecision,
  PlanReviewDecision,
} from '@litter-bear/types/protocol';
import { StreamTaskEventType } from '../../../../stream-task/stream-task-event.types';
import { LlmService } from '../../../../llm/llm.service';
import { CommonChatAgentFactory } from '../../../agents/common-chat-agent/common-chat-agent.factory';
import { AgentCheckpointerService } from '../../../agents/common-chat-agent/agent-checkpointer.service';
import {
  buildHitlMiddleware,
  buildHitlResponse,
  emitApprovalFromValue,
  readRawInterrupt,
  type HitlRequestValue,
} from '../../../agents/common-chat-agent/agent-hitl';
import {
  mapGraphStream,
  type GraphModeChunk,
} from '../../../agents/common-chat-agent/agent-message-stream.mapper';
import { toLangChainMessages } from '../../../agents/common-chat-agent/llm-message.mapper';
import {
  type AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentLoopWorkflowEvent,
} from '../../agent-loop.types';
import {
  buildPlanReadySummary,
  buildStepDoneSummary,
} from '../../trace/trace-summary.builder';
import { PlannerService } from '../planner.service';
import { STEP_EVALUATOR, type StepEvaluator } from '../step-evaluator';
import { buildStepPrompt, buildSynthesisPrompt } from '../plan-prompt.builder';
import { createStepContextMiddleware } from '../step-tool-scope';
import type { AgentPlan } from '../plan.types';
import { toLegacyPlanLoopStrategy } from './plan-graph.definition';
import type { PlanLoopPolicy } from './plan-loop-policy';

/**
 * 图递归上限
 * @description 每个计划步骤要走 prepare_step → execute → collect_step 三个超步，
 * 加上 create_plan 与 synthesize，6 步计划约 20 个超步。默认 25 会卡在长计划上，
 * 这里留一倍余量；真正的步数闸门是 maxSteps，不是它。
 */
const GRAPH_RECURSION_LIMIT = 60;

/** approval.required 的节点标识（编排图链路，与 ReAct 链路区分开便于回溯来源） */
const APPROVAL_NODE_KEY = 'plan_graph_approval';

/** plan.review.required 的节点标识 */
const PLAN_REVIEW_NODE_KEY = 'plan_review';

/** 计划审批中断值的判别标记（区别于工具 HITL 的 {actionRequests}） */
const PLAN_REVIEW_INTERRUPT_KIND = 'plan-review';

/** 计划审批放行的决定集合 */
const PLAN_REVIEW_ALLOWED = [
  'approve',
  'edit',
  'reject_replan',
  'reject_terminate',
] as const;

/** 终止时的固定回复（reject_terminate 不经 synthesize，由 runner 直接下发） */
const PLAN_TERMINATED_MESSAGE = '好的，已按你的选择终止本次任务。';

/** 计划审批中断值：review_plan 节点 interrupt() 抛出的形状 */
interface PlanReviewInterruptValue {
  kind: typeof PLAN_REVIEW_INTERRUPT_KIND;
  steps: { id: string; goal: string }[];
  revision: number;
}

/** 编排图收尾时只需读状态：挂起中断 + reviewOutcome（绕开编译图重型泛型） */
interface PlanGraphHandle {
  getState(config: Record<string, unknown>): Promise<{
    tasks?: Array<{ interrupts?: Array<{ value?: unknown }> }>;
    values?: { reviewOutcome?: string };
  }>;
}

/** 固定编排节点的中文展示标题（历史回显用）；计划出的动态步骤用步骤目标作标题 */
const STEP_TITLES: Record<string, string> = {
  create_plan: '整理计划',
  synthesize: '整合结果生成回复',
};

/**
 * 编排状态
 * @description messages 复用官方 reducer（每步会被 prepare_step 整体重置），
 * 其余是 plan/hybrid 的编排字段。observations 用累加 reducer，其它字段直接覆盖。
 */
const PlanGraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  plan: Annotation<AgentPlan>({
    reducer: (_prev, next) => next,
    default: () => ({ steps: [], fromModel: false }),
  }),
  stepIndex: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  observations: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  /** 最近一步是否触发过工具调用（hybrid 的评估器要用） */
  lastStepHadToolCalls: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  /** 计划审批打回累积的用户意见（打回时喂给 planner 重规划） */
  planFeedback: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  /** review_plan 节点的决定去向，供条件边路由（默认直穿） */
  reviewOutcome: Annotation<'proceed' | 'replan' | 'terminate'>({
    reducer: (_prev, next) => next,
    default: () => 'proceed',
  }),
  /**
   * 本步提示词 / 本步允许工具：经 state 通道传进 execute 子图（messages 注入到不了子图，
   * 见 step-tool-scope）。由 prepare_step 写、StepContext 中间件读。
   */
  stepInstruction: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  stepAllowedTools: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /**
   * 需按步隔离的审批工具 = 审批工具 ∩「计划里被某步标注过」。由 create_plan 计算一次。
   * 计划从没安排的审批工具不入此集（不隔离），避免把它锁死到不可调用。
   */
  scopedApprovalTools: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
});

type PlanGraphStateType = typeof PlanGraphState.State;

@Injectable()
export class PlanGraphBuilder {
  constructor(
    private readonly planner: PlannerService,
    private readonly agentFactory: CommonChatAgentFactory,
    private readonly llmService: LlmService,
    private readonly checkpointer: AgentCheckpointerService,
    @Inject(STEP_EVALUATOR) private readonly evaluator: StepEvaluator,
  ) {}

  /**
   * 执行 plan/hybrid 编排图
   * @param input agent loop 输入上下文
   * @param strategy 策略模式（PlanExecute=跑完所有步骤，Hybrid=按评估器动态提前结束）
   * @returns 返回统一 agent loop 事件流
   * @description 真实规划 + 分步执行 + 最终综合，跑在 LangGraph StateGraph 上：
   * create_plan → (prepare_step → execute → collect_step)* → synthesize。
   * 每步用同一个 ReAct 子图执行，进步前重置 messages 做步骤隔离；
   * 编排事件由节点内 `config.writer()` 推出，模型/工具事件从 messages 流解析。
   */
  async *stream(
    input: AgentLoopInput,
    policy: PlanLoopPolicy,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    const strategy = toLegacyPlanLoopStrategy(policy);
    const isDynamic = policy.stopPolicy === 'evaluate-after-step';

    yield {
      type: StreamTaskEventType.AgentLoopStart,
      payload: {
        nodeKey: 'agent_loop_controller',
        traceKey: `agent-loop:${strategy}`,
        agent: 'common-chat-agent',
        strategy,
        publicStatus: isDynamic ? '正在规划任务并动态执行' : '正在规划任务步骤',
      },
    };

    const hitlTools = this.resolveHitlTools(input);
    const planReview = this.isPlanReviewEnabled(input, policy);
    const graph = this.buildGraph(input, policy, hitlTools, planReview);

    const stream = await graph.stream(
      { messages: toLangChainMessages(input.messages) },
      this.buildStreamConfig(input, hitlTools.length > 0 || planReview),
    );
    yield* this.consume(stream);
    yield* this.finalize(graph, input.threadId);
  }

  /**
   * 恢复被人工审批挂起的编排图
   * @param input agent loop 输入（需 threadId，且工具/审批集与首轮一致）
   * @param strategy 首轮实际生效的策略（由任务层从 executionState 取回）
   * @param decision 人工决定（工具审批或计划审批，按当前挂起的中断类型解释）
   * @returns 返回续跑的事件流
   * @description 用同一 checkpointer + thread_id 重建**同形状**的编排图，
   * 把人工决定通过 Command 送回中断处续跑。计划、步骤指针、观察都在检查点里，
   * 不需要重新规划；节点闭包用的原始对话由任务层重建（同一会话、同一待回复消息，等价）。
   *
   * 挂起的中断可能是**计划审批**（review_plan 的 interrupt）或**工具审批**（子图内
   * humanInTheLoopMiddleware），故先读中断形状再决定 resume 值的构造。一次任务可能多轮
   * 进出等待态——每步各中断一次或计划被反复打回，故续跑后仍要再检测一次挂起。
   */
  async *resume(
    input: AgentLoopInput,
    policy: PlanLoopPolicy,
    decision: ApprovalDecision | PlanReviewDecision,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    if (!input.threadId) {
      throw new Error('resume requires threadId');
    }

    const hitlTools = input.approvalToolNames ?? [];
    const planReview = this.isPlanReviewEnabled(input, policy);
    const graph = this.buildGraph(input, policy, hitlTools, planReview);

    const raw = await readRawInterrupt(graph, input.threadId);
    const resumeValue = this.isPlanReviewInterrupt(raw)
      ? // 计划审批：PlanReviewDecision 直接成为 review_plan 里 interrupt() 的返回值
        (decision as PlanReviewDecision)
      : // 工具审批：映射为 HITLResponse.decisions
        buildHitlResponse(
          decision as ApprovalDecision,
          (raw as HitlRequestValue | undefined)?.actionRequests ?? [],
        );

    const stream = await graph.stream(
      new Command({ resume: resumeValue }),
      this.buildStreamConfig(input, hitlTools.length > 0 || planReview),
    );
    yield* this.consume(stream);
    yield* this.finalize(graph, input.threadId);
  }

  /**
   * 续跑/首轮结束后的收尾：发挂起审批，或终止时下发固定回复
   * @param graph 已跑到停顿或结束的编排图
   * @param threadId 会话标识；缺省表示无 checkpointer、不可能有中断或终止
   * @description 一次 getState 同时判断「是否仍挂起」与「是否被终止」，避免两次读状态。
   */
  private async *finalize(
    graph: PlanGraphHandle,
    threadId: string | undefined,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    if (!threadId) {
      return;
    }

    const state = await graph.getState({
      configurable: { thread_id: threadId },
    });
    const raw = (state.tasks ?? []).flatMap((t) => t.interrupts ?? [])[0]
      ?.value;

    if (raw !== undefined) {
      yield* this.emitPending(raw);
      return;
    }

    // reject_terminate 走到 END，不经 synthesize、无正文；由 runner 补一句固定回复，
    // 否则助手气泡空白。runner 自己 yield，不过 synthesize 白名单，天然不受过滤影响。
    if (state.values?.reviewOutcome === 'terminate') {
      yield {
        type: StreamTaskEventType.MessageDelta,
        delta: PLAN_TERMINATED_MESSAGE,
      };
    }
  }

  /**
   * 按挂起中断的形状分发审批事件
   * @param raw getState 读出的中断值
   */
  private *emitPending(
    raw: unknown,
  ): Generator<AgentLoopStreamEvent, void, unknown> {
    if (this.isPlanReviewInterrupt(raw)) {
      yield {
        type: StreamTaskEventType.PlanReviewRequired,
        payload: {
          steps: raw.steps,
          allowedDecisions: [...PLAN_REVIEW_ALLOWED],
          revision: raw.revision,
          nodeKey: PLAN_REVIEW_NODE_KEY,
          traceKey: 'plan-review',
          publicStatus: '待确认计划',
        },
      };
      return;
    }
    if (raw && typeof raw === 'object') {
      yield* emitApprovalFromValue(raw, APPROVAL_NODE_KEY);
    }
  }

  private isPlanReviewEnabled(
    input: AgentLoopInput,
    policy: PlanLoopPolicy,
  ): boolean {
    // 无 threadId 就没有稳定 checkpoint 键，无法暂停/恢复。
    return policy.planReview === 'required' && !!input.threadId;
  }

  private isPlanReviewInterrupt(raw: unknown): raw is PlanReviewInterruptValue {
    return (
      !!raw &&
      typeof raw === 'object' &&
      (raw as { kind?: unknown }).kind === PLAN_REVIEW_INTERRUPT_KIND
    );
  }

  /**
   * 消费编排图的多模式流
   * @description 首轮与恢复共用：两条路径必须产出同一套事件，分开写会漂移。
   */
  private async *consume(
    stream: AsyncIterable<unknown>,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    // LangGraph 把 custom 载荷推断为 unknown（writer 是通用回调，无法从图上反推）。
    // 本图内所有 writer 调用都经 emit() 收口，载荷必然是 AgentLoopWorkflowEvent，
    // 故此处按 GraphModeChunk 消费；断言只此一处，不扩散。
    const chunks = stream as AsyncIterable<GraphModeChunk>;

    for await (const { event, namespace } of mapGraphStream(chunks)) {
      // 只有 synthesize 节点的模型输出是**最终答案**，才下发为 message.delta。
      // 其余模型文本都是内部过程，必须拦掉：
      //   - create_plan 里 planner 的结构化 JSON（外层节点，命名空间 ['create_plan:*']）
      //   - 各步 ReAct 子图的推理（命名空间 ['execute:*', ...]，2 段）
      // 早先用「命名空间 ≥ 2 段」只挡住了子图，漏了 create_plan 这个**外层**节点，
      // planner 的计划 JSON 就此漏成正文。改为白名单：仅 synthesize 的 delta 放行。
      if (
        event.type === StreamTaskEventType.MessageDelta &&
        !this.isFinalAnswerNamespace(namespace)
      ) {
        continue;
      }

      yield event;
    }
  }

  /**
   * 判断消息块是否来自 synthesize 节点（最终答案）
   * @param namespace mapGraphStream 产出的来源命名空间
   * @returns 命名空间首段节点名为 synthesize 时为真
   * @description 命名空间形如 `['synthesize:<uuid>']`，首段冒号前即节点名。
   * 只有它产出的文本是用户可见正文，其余（planner / 步骤推理）一律拦在内部。
   */
  private isFinalAnswerNamespace(namespace: string[]): boolean {
    return namespace[0]?.split(':')[0] === 'synthesize';
  }

  /**
   * 解析本轮需要人工审批的工具
   * @description 与 ReAct 链路同一判据：没有 threadId 就没有稳定的 checkpoint 键，
   * 中断了也恢复不回来，故视为不启用 HITL。
   */
  private resolveHitlTools(input: AgentLoopInput): string[] {
    if (!input.threadId) {
      return [];
    }
    return input.approvalToolNames ?? [];
  }

  private buildStreamConfig(
    input: AgentLoopInput,
    needsCheckpoint: boolean,
  ): {
    streamMode: StreamMode[];
    subgraphs: boolean;
    recursionLimit: number;
    signal: AbortSignal | undefined;
    configurable: Record<string, unknown>;
  } {
    return {
      // 编排事件走 custom，模型/工具事件走 messages；subgraphs 才能拿到子图内部的块
      streamMode: ['messages', 'custom'],
      subgraphs: true,
      recursionLimit: GRAPH_RECURSION_LIMIT,
      signal: input.abortSignal,
      configurable:
        needsCheckpoint && input.threadId ? { thread_id: input.threadId } : {},
    };
  }

  /**
   * 构建本轮编排图
   * @param input agent loop 输入上下文
   * @param strategy 策略模式
   * @param hitlTools 需人工审批的工具名（空 = 不启用工具 HITL）
   * @param planReview 是否开启计划审批（plan_execute 默认开）
   * @description 图按请求构建：节点要闭包捕获本轮的 input / model / 原始对话。
   * plan 与 hybrid 共用同一张图，差异在 collect_step 之后的条件边；计划审批多一个
   * review_plan 节点。首轮与恢复都走这里，**必须产出同形状的图**——否则检查点对不上。
   */
  private buildGraph(
    input: AgentLoopInput,
    policy: PlanLoopPolicy,
    hitlTools: string[],
    planReview: boolean,
  ) {
    const maxSteps = policy.maxSteps;
    const isDynamic = policy.stopPolicy === 'evaluate-after-step';
    const strategy = toLegacyPlanLoopStrategy(policy);
    const useHitl = hitlTools.length > 0;
    const needsCheckpoint = useHitl || planReview;
    const model = this.llmService.createChatModel(
      this.llmService.resolveTextRequest(input.llm),
    );
    const conversation = toLangChainMessages(input.messages);

    // 子图执行器：与 ReAct 链路同一个 factory，但**不带 systemPrompt**——
    // 每步的提示词由 prepare_step 作为 SystemMessage 注入，故不能在此固定。
    // 也**不挂 checkpointer**：图状态由外层统一托管，各存各的就无法联动，
    // 内层中断也就穿不到外层（已实测）。
    // StepContext 始终挂：它既把本步提示词送达模型（messages 注入到不了子图的补救），
    // 又按步收窄工具（审批类工具仅在其步可见）。放在 HITL 之前：先收窄可见工具，
    // 再由 HITL 对真正触发的调用做审批。二者独立组合。
    const middleware = [
      createStepContextMiddleware(),
      ...(useHitl ? buildHitlMiddleware(hitlTools) : []),
    ];
    const executor = this.agentFactory.createAgent({
      model,
      tools: input.tools,
      middleware,
    });

    return (
      new StateGraph(PlanGraphState)
        .addNode('create_plan', async (state, config) => {
          this.emit(config, {
            type: StreamTaskEventType.WorkflowStepStart,
            payload: this.stepPayload(
              strategy,
              'create_plan',
              '正在拆解任务步骤',
            ),
          });

          // 打回重规划时带上累积意见；首轮 planFeedback 为空，行为不变。
          const plan = await this.planner.plan(
            input,
            maxSteps,
            state.planFeedback,
          );

          this.emit(config, {
            type: StreamTaskEventType.WorkflowStepDone,
            payload: {
              ...this.stepPayload(strategy, 'create_plan', '已完成任务拆解'),
              summary: buildPlanReadySummary(plan.steps.length),
              stepCount: plan.steps.length,
              steps: plan.steps.map((step) => step.goal),
              fromModel: plan.fromModel,
            },
          });

          // 只隔离「计划确实安排了」的审批工具：某步 suggestedTools 标注过它才纳入。
          // 计划从没标注的审批工具不隔离，避免把它锁死到永远不可调用。
          const scopedApprovalTools = hitlTools.filter((name) =>
            plan.steps.some((step) => step.suggestedTools?.includes(name)),
          );

          return { plan, stepIndex: 0, scopedApprovalTools };
        })
        // 计划审批关卡：出计划后、执行前暂停等人工确认。未开启时直穿（reviewOutcome 默认 proceed）。
        .addNode('review_plan', (state) => {
          if (!planReview) {
            return { reviewOutcome: 'proceed' as const };
          }
          // interrupt() 抛出计划供人工回填；resume 时返回 PlanReviewDecision。
          // 规划已在 create_plan 完成，本节点只做 interrupt——即便 resume 后整节点重跑，
          // 代价也只是再读一次 state，不会重复调用 planner。
          const decision = interrupt<
            PlanReviewInterruptValue,
            PlanReviewDecision
          >({
            kind: PLAN_REVIEW_INTERRUPT_KIND,
            steps: state.plan.steps.map((step) => ({
              id: step.id,
              goal: step.goal,
            })),
            revision: state.planFeedback.length,
          });

          if (decision.decision === 'edit') {
            const steps = (decision.editedSteps ?? [])
              .map((item) => item.goal.trim())
              .filter((goal) => goal.length > 0)
              .map((goal, index) => ({ id: `step-${index + 1}`, goal }));
            return {
              plan: { steps, fromModel: false },
              reviewOutcome: 'proceed' as const,
            };
          }
          if (decision.decision === 'reject_replan') {
            return {
              planFeedback: [decision.feedback?.trim() || '请重新规划'],
              reviewOutcome: 'replan' as const,
            };
          }
          if (decision.decision === 'reject_terminate') {
            return { reviewOutcome: 'terminate' as const };
          }
          return { reviewOutcome: 'proceed' as const };
        })
        .addNode('prepare_step', (state, config) => {
          const step = state.plan.steps[state.stepIndex];

          this.emit(config, {
            type: StreamTaskEventType.WorkflowStepStart,
            payload: this.stepPayload(strategy, step.id, step.goal, step.goal),
          });

          // 每步重置为「只带原始对话」：步骤间互不看彼此的过程消息（步骤隔离，控 token）。
          // MessagesAnnotation 的 reducer 只累加，必须先整体清空。
          //
          // 本步提示词与允许工具**不走 messages**：实测把编译子图（createAgent().graph）作为
          // 外层节点嵌入时，prepare_step 通过 messages 注入的前导提示词到不了子图的模型调用
          // （子图只看到原始对话）。改走 state 通道（stepInstruction/stepAllowedTools），
          // 由 StepContext 中间件在子图的模型调用里读出——已实测 state 通道能穿透。
          return {
            messages: [
              new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
              ...conversation,
            ],
            stepInstruction: buildStepPrompt(
              input,
              state.plan,
              step,
              state.observations,
            ),
            stepAllowedTools:
              step.suggestedTools?.filter((name) => name.length > 0) ?? [],
          };
        })
        // createAgent 返回的 ReactAgent 是门面对象（有 invoke/stream 但不是 Runnable
        // 子类），直接当节点会被拒绝；真正的编译图在 .graph 上。
        .addNode('execute', executor.graph)
        .addNode('collect_step', (state, config) => {
          const step = state.plan.steps[state.stepIndex];
          const stepsDone = state.stepIndex + 1;

          this.emit(config, {
            type: StreamTaskEventType.WorkflowStepDone,
            payload: {
              ...this.stepPayload(
                strategy,
                step.id,
                `已完成：${step.goal}`,
                step.goal,
              ),
              summary: buildStepDoneSummary(stepsDone, step.goal),
            },
          });

          return {
            observations: [this.readLastAiText(state.messages)],
            stepIndex: stepsDone,
            lastStepHadToolCalls: state.messages.some(
              (message) => message.type === 'tool',
            ),
          };
        })
        .addNode('synthesize', async (state, config) => {
          this.emit(config, {
            type: StreamTaskEventType.WorkflowStepStart,
            payload: this.stepPayload(
              strategy,
              'synthesize',
              '正在整合结果生成回复',
            ),
          });
          this.emit(config, {
            type: StreamTaskEventType.ModelCallStart,
            payload: {
              nodeKey: 'synthesize_model',
              traceKey: 'model:synthesize',
              model: input.llm?.model.model,
              provider: input.llm?.model.provider,
              publicStatus: '正在生成回复',
            },
          });

          // 不带工具的一次收敛调用；节点内 invoke 的 token 块照样会从 messages 流出去，
          // 命名空间是单段（synthesize:*），据此与子图的步骤文本区分。
          const answer = await model.invoke([
            new SystemMessage(buildSynthesisPrompt(input, state.observations)),
            ...conversation,
          ]);

          this.emit(config, {
            type: StreamTaskEventType.ModelCallDone,
            payload: {
              nodeKey: 'synthesize_model',
              traceKey: 'model:synthesize',
              model: input.llm?.model.model,
              provider: input.llm?.model.provider,
            },
          });
          this.emit(config, {
            type: StreamTaskEventType.WorkflowStepDone,
            payload: this.stepPayload(strategy, 'synthesize', '已生成回复'),
          });

          return { messages: [answer] };
        })
        .addEdge(START, 'create_plan')
        .addEdge('create_plan', 'review_plan')
        // 计划审批分流：proceed→执行；replan→回 create_plan 带意见重规划；terminate→收尾
        .addConditionalEdges('review_plan', (state: PlanGraphStateType) => {
          if (state.reviewOutcome === 'replan') return 'create_plan';
          if (state.reviewOutcome === 'terminate') return END;
          return 'prepare_step';
        })
        .addEdge('prepare_step', 'execute')
        .addEdge('execute', 'collect_step')
        .addConditionalEdges('collect_step', (state: PlanGraphStateType) =>
          this.shouldContinue(state, { maxSteps, isDynamic }),
        )
        .addEdge('synthesize', END)
        // 外层持有 checkpointer：编排状态（计划/步骤指针/观察）与内层中断都由它托管，
        // 恢复时按 thread_id 取回。工具审批或计划审批任一开启都需要它，否则暂停/恢复不成立。
        .compile({
          checkpointer: needsCheckpoint ? this.checkpointer.get() : undefined,
        })
    );
  }

  /**
   * 判断是否继续下一步
   * @returns 返回下一个节点名
   * @description 与原 controller 循环逐条对应：步骤跑完或撞到步数预算即收尾；
   * hybrid 额外让评估器判断信息是否已足够以提前结束。
   */
  private shouldContinue(
    state: PlanGraphStateType,
    options: { maxSteps: number; isDynamic: boolean },
  ): 'prepare_step' | 'synthesize' {
    const exhausted =
      state.stepIndex >= state.plan.steps.length ||
      state.stepIndex >= options.maxSteps;
    if (exhausted) {
      return 'synthesize';
    }

    if (
      options.isDynamic &&
      this.evaluator.enough({
        stepsDone: state.stepIndex,
        maxSteps: options.maxSteps,
        plannedSteps: state.plan.steps.length,
        lastResult: {
          text: state.observations[state.observations.length - 1] ?? '',
          hadToolCalls: state.lastStepHadToolCalls,
        },
      })
    ) {
      return 'synthesize';
    }

    return 'prepare_step';
  }

  /**
   * 从节点里发编排事件
   * @description 必须走 `config.writer`——`@langchain/langgraph` 顶层导出的 `writer()`
   * 在节点里调用不抛错也不产出任何块（静默失效，见 `scripts/debug-graph-events.cjs`）。
   * 收口成一个方法，既避免误用，也让载荷受 AgentLoopWorkflowEvent 约束。
   *
   * `writer` 在 `LangGraphRunnableConfig` 上是可选的（该类型把 Runtime 整体 Partial 了），
   * 实际执行中恒存在；可选调用只为满足类型，不是容错分支。
   */
  private emit(
    config: LangGraphRunnableConfig,
    event: AgentLoopWorkflowEvent,
  ): void {
    config.writer?.(event);
  }

  /** 读取本步产出的助手文本（作为观察） */
  private readLastAiText(messages: BaseMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.type !== 'ai') {
        continue;
      }
      return typeof message.content === 'string' ? message.content : '';
    }
    return '';
  }

  private stepPayload(
    strategy: AgentStrategyMode,
    step: string,
    publicStatus: string,
    title?: string,
  ) {
    return {
      strategy,
      step,
      title: title ?? STEP_TITLES[step],
      nodeKey: step,
      traceKey: `workflow:${strategy}:${step}`,
      publicStatus,
    };
  }
}
