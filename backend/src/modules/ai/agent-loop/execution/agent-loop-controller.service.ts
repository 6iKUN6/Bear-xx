import { Inject, Injectable } from '@nestjs/common';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';
import { CommonChatAgentService } from '../../agents/common-chat-agent/common-chat-agent.service';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
} from '../agent-loop.types';
import { PlannerService } from './planner.service';
import { STEP_EVALUATOR, type StepEvaluator } from './step-evaluator';
import type { AgentPlan, PlanStep, StepExecutionResult } from './plan.types';

const DEFAULT_MAX_STEPS = 6;

@Injectable()
export class AgentLoopController {
  constructor(
    private readonly planner: PlannerService,
    private readonly commonChatAgentService: CommonChatAgentService,
    @Inject(STEP_EVALUATOR) private readonly evaluator: StepEvaluator,
  ) {}

  /**
   * 执行 plan/hybrid 监督循环
   * @param input agent loop 输入上下文
   * @param strategy 策略模式（PlanExecute=静态跑完所有步骤，Hybrid=按评估器动态提前结束）
   * @returns 返回统一 agent loop 事件流
   * @description 真实规划 + 分步执行 + 最终综合：先用 planner 拆解步骤（发真实 step 事件），
   * 逐步用 ReAct executor 执行（转发工具事件、收集文本为观察，不直接作为最终答案），
   * Hybrid 模式每步后用评估器判断信息是否足够以提前收尾；最后做一次不带工具的综合调用，流式输出最终回复。
   */
  async *stream(
    input: AgentLoopInput,
    strategy: AgentStrategyMode,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
    const isDynamic = strategy === AgentStrategyMode.Hybrid;

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

    yield this.stepStart(strategy, 'create_plan', '正在拆解任务步骤');
    const plan = await this.planner.plan(input, maxSteps);
    yield this.stepDone(strategy, 'create_plan', '已完成任务拆解', {
      stepCount: plan.steps.length,
      steps: plan.steps.map((step) => step.goal),
      fromModel: plan.fromModel,
    });

    const observations: string[] = [];
    let stepsDone = 0;

    for (const step of plan.steps) {
      if (stepsDone >= maxSteps) {
        break;
      }

      yield this.stepStart(strategy, step.id, step.goal);
      const result = yield* this.executeStep(input, plan, step, observations);
      observations.push(result.text);
      stepsDone += 1;
      yield this.stepDone(strategy, step.id, `已完成：${step.goal}`);

      if (
        isDynamic &&
        this.evaluator.enough({
          stepsDone,
          maxSteps,
          plannedSteps: plan.steps.length,
          lastResult: result,
        })
      ) {
        break;
      }
    }

    yield this.stepStart(strategy, 'synthesize', '正在整合结果生成回复');
    yield* this.synthesize(input, observations);
    yield this.stepDone(strategy, 'synthesize', '已生成回复');
  }

  /**
   * 执行单个步骤
   * @returns 生成器额外返回该步骤的执行结果（观察文本 + 是否触发工具）
   * @description 复用统一 ReAct executor；转发工具调用事件供前端展示状态，
   * 但把该步骤的助手文本收集为观察，不作为最终答案直接推给用户（最终答案由 synthesize 统一流式输出）。
   */
  private async *executeStep(
    input: AgentLoopInput,
    plan: AgentPlan,
    step: PlanStep,
    observations: string[],
  ): AsyncGenerator<AgentLoopStreamEvent, StepExecutionResult, unknown> {
    let text = '';
    let hadToolCalls = false;

    for await (const event of this.commonChatAgentService.streamEvents({
      messages: input.messages,
      systemPrompt: this.buildStepPrompt(input, plan, step, observations),
      llm: input.llm,
      tools: input.tools,
      abortSignal: input.abortSignal,
    })) {
      if (event.type === StreamTaskEventType.MessageDelta) {
        text += event.delta;
        continue;
      }

      if (
        event.type === StreamTaskEventType.ToolCallStart ||
        event.type === StreamTaskEventType.ToolCallDelta ||
        event.type === StreamTaskEventType.ToolCallDone
      ) {
        hadToolCalls = true;
      }

      yield event;
    }

    return { text, hadToolCalls };
  }

  /**
   * 综合观察生成最终回复
   * @description 不带工具，基于所有步骤观察做一次收敛回答，流式输出 message.delta 作为最终答案。
   */
  private async *synthesize(
    input: AgentLoopInput,
    observations: string[],
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    yield {
      type: StreamTaskEventType.ModelCallStart,
      payload: {
        nodeKey: 'synthesize_model',
        traceKey: 'model:synthesize',
        model: input.llm?.model.model,
        provider: input.llm?.model.provider,
        publicStatus: '正在生成回复',
      },
    };

    for await (const event of this.commonChatAgentService.streamEvents({
      messages: input.messages,
      systemPrompt: this.buildSynthesisPrompt(input, observations),
      llm: input.llm,
      tools: [],
      abortSignal: input.abortSignal,
    })) {
      yield event;
    }

    yield {
      type: StreamTaskEventType.ModelCallDone,
      payload: {
        nodeKey: 'synthesize_model',
        traceKey: 'model:synthesize',
        model: input.llm?.model.model,
        provider: input.llm?.model.provider,
      },
    };
  }

  private buildStepPrompt(
    input: AgentLoopInput,
    plan: AgentPlan,
    step: PlanStep,
    observations: string[],
  ): string {
    const sections: string[] = [];
    if (input.systemPrompt) {
      sections.push(input.systemPrompt);
    }

    sections.push(
      `## 任务计划\n${plan.steps
        .map((item, index) => `${index + 1}. ${item.goal}`)
        .join('\n')}`,
    );
    sections.push(`## 当前步骤\n${step.goal}`);

    if (observations.length > 0) {
      sections.push(
        `## 已有信息\n${observations
          .map((text, index) => `【步骤${index + 1}】${text}`)
          .join('\n')}`,
      );
    }

    sections.push(
      '只专注完成"当前步骤"，需要时调用工具；简洁输出该步骤的结果，不要重复整体计划。',
    );

    return sections.join('\n\n');
  }

  private buildSynthesisPrompt(
    input: AgentLoopInput,
    observations: string[],
  ): string {
    const sections: string[] = [];
    if (input.systemPrompt) {
      sections.push(input.systemPrompt);
    }

    if (observations.length > 0) {
      sections.push(
        `## 已收集的信息\n${observations
          .map((text, index) => `【步骤${index + 1}】${text}`)
          .join('\n')}`,
      );
    }

    sections.push(
      '请基于以上已收集的信息，直接、完整地回答用户的请求；不要提及内部步骤、计划或工具细节。',
    );

    return sections.join('\n\n');
  }

  private stepStart(
    strategy: AgentStrategyMode,
    step: string,
    publicStatus: string,
  ): AgentLoopStreamEvent {
    return {
      type: StreamTaskEventType.WorkflowStepStart,
      payload: this.buildStepPayload(strategy, step, publicStatus),
    };
  }

  private stepDone(
    strategy: AgentStrategyMode,
    step: string,
    publicStatus: string,
    extra: Record<string, unknown> = {},
  ): AgentLoopStreamEvent {
    return {
      type: StreamTaskEventType.WorkflowStepDone,
      payload: {
        ...this.buildStepPayload(strategy, step, publicStatus),
        ...extra,
      },
    };
  }

  private buildStepPayload(
    strategy: AgentStrategyMode,
    step: string,
    publicStatus: string,
  ) {
    return {
      strategy,
      step,
      nodeKey: step,
      traceKey: `workflow:${strategy}:${step}`,
      publicStatus,
    };
  }
}
