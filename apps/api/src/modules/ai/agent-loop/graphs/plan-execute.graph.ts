import { Injectable } from '@nestjs/common';
import { AgentLoopController } from '../execution/agent-loop-controller.service';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyGraph,
} from '../agent-loop.types';

@Injectable()
export class PlanExecuteGraph implements AgentStrategyGraph {
  readonly mode = AgentStrategyMode.PlanExecute;

  constructor(private readonly controller: AgentLoopController) {}

  /**
   * 执行计划-执行策略
   * @param input agent loop 输入上下文
   * @returns 返回带真实步骤事件的事件流
   * @description 静态模式：由 controller 先规划再逐步执行，跑完全部步骤后综合输出。
   */
  stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    return this.controller.stream(input, this.mode);
  }
}
