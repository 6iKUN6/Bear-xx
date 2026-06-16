import { Injectable } from '@nestjs/common';
import { StreamTaskEventType } from '../../stream-task/stream-task-event.types';
import {
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyDecision,
} from './agent-loop.types';
import { StrategyRegistryService } from './strategy-registry.service';
import { StrategyRouterService } from './strategy-router.service';

@Injectable()
export class AgentLoopRunnerService {
  constructor(
    private readonly strategyRouter: StrategyRouterService,
    private readonly strategyRegistry: StrategyRegistryService,
  ) {}

  /**
   * 执行 agent loop 编排
   * @param input agent loop 输入上下文
   * @returns 返回统一 agent loop 事件流
   * @description 负责策略选择、策略事件发布和策略图执行；第一版使用规则路由和白名单策略注册表。
   */
  async *stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    const decision = this.strategyRouter.route(input);

    yield {
      type: StreamTaskEventType.StrategySelected,
      payload: this.serializeDecision(decision),
    };

    for (const skill of decision.skills) {
      yield {
        type: StreamTaskEventType.SkillSelected,
        payload: {
          skill,
          strategy: decision.mode,
        },
      };
    }

    const graph = this.strategyRegistry.resolve(decision.mode);
    for await (const event of graph.stream(input)) {
      yield event;
    }
  }

  private serializeDecision(decision: AgentStrategyDecision) {
    return {
      mode: decision.mode,
      confidence: decision.confidence,
      reason: decision.reason,
      skills: decision.skills,
      toolGroups: decision.toolGroups,
      maxSteps: decision.maxSteps,
      publicStatus: decision.publicStatus,
    };
  }
}
