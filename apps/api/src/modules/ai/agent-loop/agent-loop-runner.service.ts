import { Injectable } from '@nestjs/common';
import type {
  ApprovalDecision,
  PlanReviewDecision,
} from '@litter-bear/types/protocol';
import { StreamTaskEventType } from '../../stream-task/stream-task-event.types';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentLoopStreamEvent,
  type AgentStrategyDecision,
  type PersistedAgentStrategySnapshot,
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
    const decision = await this.strategyRouter.route(input);
    const capabilities = await this.capabilityResolver.resolve(
      decision,
      input.userId,
      input.mcdonaldsCredentialId,
    );

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
      maxSteps: decision.maxSteps,
      threadId: input.threadId,
      approvalToolNames: capabilities.approvalToolNames,
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
   * 解析 HITL 恢复所需的能力装配
   * @param input agent loop 输入（可带 agentConfig）
   * @returns 返回续跑所需的 { tools, approvalToolNames, systemPrompt }
   * @description 恢复不重新路由，故用 config 派生 decision（强制或 config-only）经 CapabilityResolver 装配，
   * 与 stream 路径产出同一套工具/审批集/系统提示词，避免恢复用全量工具、与受限主链路不一致。
   */
  async resolveResumeCapabilities(
    input: AgentLoopInput,
    snapshot?: PersistedAgentStrategySnapshot,
  ): Promise<{
    tools: unknown[];
    approvalToolNames: string[];
    systemPrompt: string | undefined;
  }> {
    const cfg = input.agentConfig;
    const decision = snapshot
      ? this.buildDecisionFromSnapshot(snapshot)
      : cfg && cfg.defaultStrategy !== 'auto'
        ? this.strategyRouter.buildForcedDecision(
            cfg,
            input.userId,
            input.mcdonaldsCredentialId,
          )
        : this.strategyRouter.buildResumeDecision(
            cfg,
            input.userId,
            input.mcdonaldsCredentialId,
          );
    const capabilities = await this.capabilityResolver.resolve(
      decision,
      input.userId,
      snapshot?.mcdonaldsCredentialId ?? input.mcdonaldsCredentialId,
    );

    return {
      tools: [...capabilities.tools, ...capabilities.subagentTools],
      approvalToolNames: capabilities.approvalToolNames,
      systemPrompt: this.mergeSystemPrompt(
        input.systemPrompt,
        capabilities.systemPromptAdditions,
      ),
    };
  }

  /**
   * 将持久化快照恢复为能力装配决策
   * @param snapshot 首轮经闭集校验后的策略快照
   * @returns 只用于恢复期能力解析的策略决策
   * @description 快照来自首轮 strategy.selected，不能在恢复时重新路由或重套 agent 配置，
   * 以保证 LangGraph 检查点对应的工具集和 HITL 审批集不发生漂移。
   */
  private buildDecisionFromSnapshot(
    snapshot: PersistedAgentStrategySnapshot,
  ): AgentStrategyDecision {
    return {
      mode: snapshot.strategy,
      confidence: 1,
      reason: 'HITL 恢复：复用首轮策略能力快照',
      skills: snapshot.skills,
      toolGroups: snapshot.toolGroups,
      maxSteps: snapshot.maxSteps,
      publicStatus: '正在恢复已确认的任务',
      source: 'resume',
    };
  }

  /**
   * 从人工审批中断处恢复执行
   * @param input agent loop 输入（须已经过 resolveResumeCapabilities 装配）
   * @param strategy 首轮实际生效的策略（任务层从 StreamTask.executionState 取回）
   * @param decision 人工决定
   * @returns 返回续跑的事件流
   * @description 恢复必须交回**首轮那个策略图**：检查点里存的是它的图状态，
   * 换个形状的图就对不上（ReAct 存的是 agent 图，plan/hybrid 存的是编排图）。
   * 故这里不重新路由，只按持久化的策略分发。
   */
  resume(
    input: AgentLoopInput,
    strategy: AgentStrategyMode,
    decision: ApprovalDecision | PlanReviewDecision,
  ): AsyncGenerator<AgentLoopStreamEvent, void, unknown> {
    const graph = this.strategyRegistry.resolve(strategy);

    if (!graph.resume) {
      // direct 无工具、永不挂起；真出现说明 executionState 里的策略与实际不符，
      // 属于必须暴露的状态不一致，不静默兜底成重跑。
      throw new Error(`策略 ${strategy} 不支持从人工审批恢复`);
    }

    return graph.resume(input, decision);
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
