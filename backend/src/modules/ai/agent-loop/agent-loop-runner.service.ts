import { Injectable } from '@nestjs/common';
import { StreamTaskEventType } from '../../stream-task/stream-task-event.types';
import {
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyDecision,
} from './agent-loop.types';
import { StrategyRegistryService } from './strategy-registry.service';
import { StrategyRouterService } from './strategy-router.service';
import { CapabilityResolver } from './capability/capability.resolver';

@Injectable()
export class AgentLoopRunnerService {
  constructor(
    private readonly strategyRouter: StrategyRouterService,
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly capabilityResolver: CapabilityResolver,
  ) {}

  /**
   * 执行 agent loop 编排
   * @param input agent loop 输入上下文
   * @returns 返回统一 agent loop 事件流
   * @description 负责策略选择、能力装配、策略事件发布和策略图执行；第一版使用规则路由和白名单策略注册表。
   */
  async *stream(
    input: AgentLoopInput,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    const decision = this.strategyRouter.route(input);
    const capabilities = this.capabilityResolver.resolve(decision);

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

    const executionInput: AgentLoopInput = {
      ...input,
      tools: [...capabilities.tools, ...capabilities.subagentTools],
      systemPrompt: this.mergeSystemPrompt(
        input.systemPrompt,
        capabilities.systemPromptAdditions,
      ),
    };

    const graph = this.strategyRegistry.resolve(decision.mode);
    for await (const event of graph.stream(executionInput)) {
      yield event;
    }
  }

  /**
   * 合并系统提示词
   * @param base 基础系统提示词
   * @param additions 技能追加的提示词片段
   * @returns 返回合并后的系统提示词
   * @description 将技能装配注入的提示词片段拼接到基础提示词之后，无追加时保持原样。
   */
  private mergeSystemPrompt(
    base: string | undefined,
    additions: string[],
  ): string | undefined {
    const segments = [base, ...additions]
      .map((segment) => segment?.trim())
      .filter((segment): segment is string => Boolean(segment));

    if (segments.length === 0) {
      return undefined;
    }

    return segments.join('\n\n');
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
