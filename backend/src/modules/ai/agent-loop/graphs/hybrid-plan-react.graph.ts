import { Injectable } from '@nestjs/common';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyGraph,
} from '../agent-loop.types';
import { CommonReactGraph } from './common-react.graph';

@Injectable()
export class HybridPlanReactGraph implements AgentStrategyGraph {
  readonly mode = AgentStrategyMode.Hybrid;

  constructor(private readonly commonReactGraph: CommonReactGraph) {}

  /**
   * 执行混合策略
   * @param input agent loop 输入上下文
   * @returns 返回计划步骤与 ReAct 子执行混合事件流
   * @description 第一版采用外层计划步骤事件 + 内层 ReAct agent loop 的保守组合，后续再扩展为真正的多步骤 LangGraph 工作流。
   */
  async *stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    yield this.stepStart('plan', '正在规划任务并选择工具');
    yield this.stepDone('plan', '已完成策略规划');
    yield this.stepStart('react_execute', '正在按步骤调用工具并生成回复');

    for await (const event of this.commonReactGraph.stream(input)) {
      yield event;
    }

    yield this.stepDone('react_execute', '已完成工具执行和回复生成');
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
