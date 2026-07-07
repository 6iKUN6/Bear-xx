import { Injectable } from '@nestjs/common';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyGraph,
} from '../agent-loop.types';
import { DirectAnswerGraph } from './direct-answer.graph';

@Injectable()
export class PlanExecuteGraph implements AgentStrategyGraph {
  readonly mode = AgentStrategyMode.PlanExecute;

  constructor(private readonly directAnswerGraph: DirectAnswerGraph) {}

  /**
   * 执行计划-执行策略
   * @param input agent loop 输入上下文
   * @returns 返回带工作流步骤反馈的事件流
   * @description 第一版先提供稳定的步骤事件和直接回答降级；后续可将 create_plan、execute_step、summarize 拆成真实 LangGraph 节点。
   */
  async *stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    yield this.stepStart('create_plan', '正在拆解任务步骤');
    yield this.stepDone('create_plan', '已完成任务拆解');
    yield this.stepStart('execute', '正在执行任务');

    for await (const event of this.directAnswerGraph.stream(input)) {
      yield event;
    }

    yield this.stepDone('execute', '已完成任务执行');
  }

  private stepStart(step: string, publicStatus: string): AgentLoopStreamEvent {
    return {
      type: StreamTaskEventType.WorkflowStepStart,
      payload: {
        strategy: this.mode,
        step,
        nodeKey: step,
        traceKey: `workflow:${this.mode}:${step}`,
        publicStatus,
      },
    };
  }

  private stepDone(step: string, publicStatus: string): AgentLoopStreamEvent {
    return {
      type: StreamTaskEventType.WorkflowStepDone,
      payload: {
        strategy: this.mode,
        step,
        nodeKey: step,
        traceKey: `workflow:${this.mode}:${step}`,
        publicStatus,
      },
    };
  }
}
