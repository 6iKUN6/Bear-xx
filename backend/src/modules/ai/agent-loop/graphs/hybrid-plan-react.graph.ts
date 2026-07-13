import { Injectable } from '@nestjs/common';
import { AgentLoopController } from '../execution/agent-loop-controller.service';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyGraph,
} from '../agent-loop.types';

@Injectable()
export class HybridPlanReactGraph implements AgentStrategyGraph {
  readonly mode = AgentStrategyMode.Hybrid;

  constructor(private readonly controller: AgentLoopController) {}

  /**
   * 执行混合策略
   * @param input agent loop 输入上下文
   * @returns 返回计划与动态执行混合的事件流
   * @description 动态模式：由 controller 规划后逐步执行，每步后用评估器判断信息是否足够以提前收尾，最后综合输出。
   */
  stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    return this.controller.stream(input, this.mode);
  }
}
