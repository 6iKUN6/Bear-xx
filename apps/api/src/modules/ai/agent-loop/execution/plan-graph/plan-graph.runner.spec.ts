import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import { StreamTaskEventType } from '../../../../stream-task/stream-task-event.types';
import { LlmService } from '../../../../llm/llm.service';
import type { ResolvedLlmTextRequest } from '../../../../llm/llm.types';
import { AgentCheckpointerService } from '../../../agents/common-chat-agent/agent-checkpointer.service';
import { CommonChatAgentFactory } from '../../../agents/common-chat-agent/common-chat-agent.factory';
import {
  type AgentLoopInput,
  type AgentLoopStreamEvent,
} from '../../agent-loop.types';
import { PlannerService } from '../planner.service';
import { PlanGraphBuilder } from './plan-graph.builder';
import {
  HYBRID_PLAN_LOOP_POLICY,
  PLAN_EXECUTE_LOOP_POLICY,
} from './plan-loop-policy';
import { PlanGraphRunner } from './plan-graph.runner';
import type { AgentPlan } from '../plan.types';
import type { StepEvaluator } from '../step-evaluator';

interface RunnerFixture {
  runner: PlanGraphRunner;
  planner: { plan: jest.Mock };
  evaluatorEnough: jest.MockedFunction<StepEvaluator['enough']>;
}

interface CollectedEvents {
  events: AgentLoopStreamEvent[];
  answer: string;
}

const baseInput: AgentLoopInput = {
  messages: [{ role: 'user', content: '请完成这项任务' }],
  systemPrompt: '你是严谨的助手。',
  maxSteps: 4,
};

const planExecutePolicy = {
  ...PLAN_EXECUTE_LOOP_POLICY,
  maxSteps: baseInput.maxSteps ?? PLAN_EXECUTE_LOOP_POLICY.maxSteps,
};
const hybridPlanPolicy = {
  ...HYBRID_PLAN_LOOP_POLICY,
  maxSteps: baseInput.maxSteps ?? HYBRID_PLAN_LOOP_POLICY.maxSteps,
};

describe('PlanGraphRunner', () => {
  it('PlanExecute 依次完成全部计划步骤后再综合回复', async () => {
    const fixture = createRunner({
      plan: plan('查找资料', '整理结论'),
      responses: ['第一步结果', '第二步结果', '最终回复'],
    });

    const result = await collect(
      fixture.runner.stream(baseInput, planExecutePolicy),
    );

    expect(
      workflowSteps(result.events, StreamTaskEventType.WorkflowStepStart),
    ).toEqual(['create_plan', 'step-1', 'step-2', 'synthesize']);
    expect(
      workflowSteps(result.events, StreamTaskEventType.WorkflowStepDone),
    ).toEqual(['create_plan', 'step-1', 'step-2', 'synthesize']);
    expect(result.answer).toBe('最终回复');
    expect(fixture.planner.plan).toHaveBeenCalledTimes(1);
  });

  it('Hybrid 在评估器判定信息足够后提前综合，不执行后续步骤', async () => {
    const fixture = createRunner({
      plan: plan('查找资料', '不应执行的补充步骤'),
      responses: ['第一步结果', '提前结束后的回复'],
      enough: true,
    });

    const result = await collect(
      fixture.runner.stream(baseInput, hybridPlanPolicy),
    );

    expect(
      workflowSteps(result.events, StreamTaskEventType.WorkflowStepStart),
    ).toEqual(['create_plan', 'step-1', 'synthesize']);
    expect(fixture.evaluatorEnough).toHaveBeenCalledWith(
      expect.objectContaining({ stepsDone: 1, plannedSteps: 2 }),
    );
    expect(result.answer).toBe('提前结束后的回复');
  });

  it('计划审批的 approve 在确认后按原计划继续执行', async () => {
    const fixture = createRunner({
      plan: plan('查询天气'),
      responses: ['天气结果', '最终回复'],
    });
    const input = withThreadId('plan-review-approve');

    const waiting = await collect(
      fixture.runner.stream(input, planExecutePolicy),
    );
    const resumed = await collect(
      fixture.runner.resume(input, planExecutePolicy, {
        decision: 'approve',
      }),
    );

    expect(planReviews(waiting.events)).toEqual([
      expect.objectContaining({
        revision: 0,
        steps: [{ id: 'step-1', goal: '查询天气' }],
      }),
    ]);
    expect(
      workflowSteps(waiting.events, StreamTaskEventType.WorkflowStepStart),
    ).toEqual(['create_plan']);
    expect(resumed.answer).toBe('最终回复');
  });

  it('计划审批的 edit 使用人工编辑后的步骤执行', async () => {
    const fixture = createRunner({
      plan: plan('原始步骤'),
      responses: ['改后第一步', '改后第二步', '最终回复'],
    });
    const input = withThreadId('plan-review-edit');

    await collect(fixture.runner.stream(input, planExecutePolicy));
    const resumed = await collect(
      fixture.runner.resume(input, planExecutePolicy, {
        decision: 'edit',
        editedSteps: [{ goal: '人工步骤一' }, { goal: '人工步骤二' }],
      }),
    );

    expect(
      workflowSteps(resumed.events, StreamTaskEventType.WorkflowStepStart),
    ).toEqual(['step-1', 'step-2', 'synthesize']);
    expect(fixture.planner.plan).toHaveBeenCalledTimes(1);
    expect(resumed.answer).toBe('最终回复');
  });

  it('计划审批的 reject_replan 带反馈重新规划并重新进入审批', async () => {
    const fixture = createRunner({
      plan: plan('原始步骤'),
      responses: [],
    });
    const input = withThreadId('plan-review-replan');

    await collect(fixture.runner.stream(input, planExecutePolicy));
    const replanned = await collect(
      fixture.runner.resume(input, planExecutePolicy, {
        decision: 'reject_replan',
        feedback: '请缩短计划',
      }),
    );

    expect(fixture.planner.plan).toHaveBeenCalledTimes(2);
    expect(fixture.planner.plan).toHaveBeenLastCalledWith(input, 4, [
      '请缩短计划',
    ]);
    expect(planReviews(replanned.events)).toEqual([
      expect.objectContaining({ revision: 1 }),
    ]);
  });

  it('计划审批的 reject_terminate 不调用综合节点并输出终止文案', async () => {
    const fixture = createRunner({
      plan: plan('原始步骤'),
      responses: [],
    });
    const input = withThreadId('plan-review-terminate');

    await collect(fixture.runner.stream(input, planExecutePolicy));
    const terminated = await collect(
      fixture.runner.resume(input, planExecutePolicy, {
        decision: 'reject_terminate',
      }),
    );

    expect(
      workflowSteps(terminated.events, StreamTaskEventType.WorkflowStepStart),
    ).not.toContain('synthesize');
    expect(terminated.answer).toBe('好的，已按你的选择终止本次任务。');
  });

  it('两轮工具审批分别在工具执行前暂停，并可依次恢复完成', async () => {
    let toolExecuted = 0;
    const weatherTool = tool(
      ({ city }: { city: string }) => {
        toolExecuted += 1;
        return `${city}晴朗`;
      },
      {
        name: 'getWeather',
        description: '查询天气',
        schema: z.object({ city: z.string() }),
      },
    );
    const fixture = createRunner({
      plan: {
        steps: [
          {
            id: 'step-1',
            goal: '查询北京天气',
            suggestedTools: ['getWeather'],
          },
          {
            id: 'step-2',
            goal: '查询上海天气',
            suggestedTools: ['getWeather'],
          },
        ],
        fromModel: true,
      },
      responses: [
        { tool: 'getWeather', city: '北京' },
        '北京天气结果',
        { tool: 'getWeather', city: '上海' },
        '上海天气结果',
        '最终回复',
      ],
    });
    const input: AgentLoopInput = {
      ...withThreadId('two-tool-approvals'),
      tools: [weatherTool],
      approvalToolNames: ['getWeather'],
    };

    const planWaiting = await collect(
      fixture.runner.stream(input, planExecutePolicy),
    );
    const firstToolWaiting = await collect(
      fixture.runner.resume(input, planExecutePolicy, {
        decision: 'approve',
      }),
    );
    const toolExecutedBeforeFirstApproval = toolExecuted;
    const secondToolWaiting = await collect(
      fixture.runner.resume(input, planExecutePolicy, {
        decision: 'approve',
      }),
    );
    const toolExecutedAfterFirstApproval = toolExecuted;
    const completed = await collect(
      fixture.runner.resume(input, planExecutePolicy, {
        decision: 'approve',
      }),
    );

    expect(planReviews(planWaiting.events)).toHaveLength(1);
    expect(approvals(firstToolWaiting.events)).toHaveLength(1);
    expect(toolExecutedBeforeFirstApproval).toBe(0);
    expect(approvals(secondToolWaiting.events)).toHaveLength(1);
    expect(toolExecutedAfterFirstApproval).toBe(1);
    expect(completed.answer).toBe('最终回复');
    expect(toolExecuted).toBe(2);
  });

  it('不将 create_plan 内的模型文本下发为 message.delta', async () => {
    const plannerText = '__PLANNER_INTERNAL_TEXT__';
    const model = fakeModel()
      .respond(new AIMessage(plannerText))
      .respond(new AIMessage('步骤结果'))
      .respond(new AIMessage('最终回复'));
    const fixture = createRunner({
      plan: plan('查询资料'),
      model,
      plannerBeforeReturn: async () => {
        await model.invoke([new HumanMessage('生成内部计划')]);
      },
    });

    const result = await collect(
      fixture.runner.stream(baseInput, planExecutePolicy),
    );

    expect(result.answer).toBe('最终回复');
    expect(result.answer).not.toContain(plannerText);
  });
});

/**
 * 创建使用固定计划、模型和内存检查点的 PlanGraphRunner 测试夹具
 * @param input 测试场景的计划、模型响应、评估器结果和可选 planner 前置动作
 * @returns 返回 runner、planner 调用记录与 evaluator 替身
 * @description 复用真实 CommonChatAgentFactory 和 LangGraph MemorySaver，避免以手写图替代生产编排行为。
 */
function createRunner(input: {
  plan: AgentPlan;
  responses: Array<string | { tool: string; city: string }>;
  enough?: boolean;
  model?: ReturnType<typeof fakeModel>;
  plannerBeforeReturn?: () => Promise<void>;
}): RunnerFixture {
  const model = input.model ?? createModel(input.responses);
  const plannerCall = input.plannerBeforeReturn
    ? jest.fn(async () => {
        await input.plannerBeforeReturn();
        return input.plan;
      })
    : jest.fn(() => Promise.resolve(input.plan));
  const planner = {
    plan: plannerCall,
  };
  const evaluatorEnough = jest
    .fn<
      ReturnType<StepEvaluator['enough']>,
      Parameters<StepEvaluator['enough']>
    >()
    .mockReturnValue(input.enough ?? false);
  const evaluator: StepEvaluator = {
    enough: evaluatorEnough,
  };
  const resolvedTextRequest: ResolvedLlmTextRequest = {
    model: {
      id: 'test-model',
      platform: 'test',
      provider: 'openai',
      model: 'test-model',
    },
    generation: {},
  };
  const llmService = {
    createChatModel: jest.fn().mockReturnValue(model),
    resolveTextRequest: () => resolvedTextRequest,
  };
  const saver = new MemorySaver();
  const checkpointer = { get: () => saver };

  return {
    runner: new PlanGraphRunner(
      new PlanGraphBuilder(
        planner as PlannerService,
        new CommonChatAgentFactory(),
        llmService as LlmService,
        checkpointer as AgentCheckpointerService,
        evaluator,
      ),
    ),
    planner,
    evaluatorEnough,
  };
}

/**
 * 创建按调用顺序返回固定响应的无网络聊天模型
 * @param responses 每次模型调用的文本回复或工具调用定义
 * @returns 返回可供 LangChain agent 与综合节点共同消费的模型替身
 * @description 队列顺序对应步骤执行、工具调用完成后的继续推理和最终综合，保证测试可重复。
 */
function createModel(
  responses: Array<string | { tool: string; city: string }>,
): ReturnType<typeof fakeModel> {
  const model = fakeModel();
  for (const response of responses) {
    if (typeof response === 'string') {
      model.respond(new AIMessage(response));
      continue;
    }
    model.respondWithTools([
      { name: response.tool, args: { city: response.city } },
    ]);
  }
  return model;
}

/**
 * 根据步骤目标构造固定计划
 * @param goals 按执行顺序给出的步骤目标
 * @returns 返回带稳定 step id 的 AgentPlan
 * @description 计划生成本身不属于本组特征测试，使用固定输入使断言聚焦在编排状态机。
 */
function plan(...goals: string[]): AgentPlan {
  return {
    steps: goals.map((goal, index) => ({
      id: `step-${index + 1}`,
      goal,
    })),
    fromModel: true,
  };
}

/**
 * 为基础输入附加 LangGraph checkpoint 标识
 * @param threadId 本次测试任务的唯一线程标识
 * @returns 返回可触发计划或工具审批中断的 AgentLoopInput
 * @description PlanGraphRunner 仅在存在 threadId 时启用可恢复审批，因此各审批场景必须使用不同标识隔离状态。
 */
function withThreadId(threadId: string): AgentLoopInput {
  return { ...baseInput, threadId };
}

/**
 * 完整消费 AgentLoop 事件流并聚合最终可见文本
 * @param stream 待消费的统一 AgentLoop 事件异步迭代器
 * @returns 返回按顺序保留的事件列表与所有 message.delta 拼接结果
 * @description 测试既需要检查工作流事件顺序，也需要验证内部文本未泄漏到用户可见输出。
 */
async function collect(
  stream: AsyncIterable<AgentLoopStreamEvent>,
): Promise<CollectedEvents> {
  const events: AgentLoopStreamEvent[] = [];
  let answer = '';

  for await (const event of stream) {
    events.push(event);
    if (event.type === StreamTaskEventType.MessageDelta) {
      answer += event.delta;
    }
  }

  return { events, answer };
}

/**
 * 从事件列表提取指定生命周期阶段的工作流步骤标识
 * @param events 已收集的统一 AgentLoop 事件
 * @param type 仅允许工作流开始或完成事件类型
 * @returns 返回按发射顺序排列的步骤标识列表
 * @description 使用判别联合在提取点收窄 payload，避免测试以非类型安全方式读取步骤字段。
 */
function workflowSteps(
  events: AgentLoopStreamEvent[],
  type:
    | StreamTaskEventType.WorkflowStepStart
    | StreamTaskEventType.WorkflowStepDone,
): string[] {
  return events.flatMap((event) =>
    event.type === type ? [event.payload.step] : [],
  );
}

/**
 * 从事件列表提取计划审批请求
 * @param events 已收集的统一 AgentLoop 事件
 * @returns 返回按发射顺序排列的计划审批载荷
 * @description 计划审批与工具审批使用不同事件类型，本函数用于断言 revision 与步骤内容。
 */
function planReviews(events: AgentLoopStreamEvent[]) {
  return events.flatMap((event) =>
    event.type === StreamTaskEventType.PlanReviewRequired
      ? [event.payload]
      : [],
  );
}

/**
 * 从事件列表提取工具审批请求
 * @param events 已收集的统一 AgentLoop 事件
 * @returns 返回按发射顺序排列的工具审批载荷
 * @description 两轮工具审批场景通过本函数确认每次暂停都产生独立审批事件。
 */
function approvals(events: AgentLoopStreamEvent[]) {
  return events.flatMap((event) =>
    event.type === StreamTaskEventType.ApprovalRequired ? [event.payload] : [],
  );
}
