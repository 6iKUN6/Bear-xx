import { Injectable } from '@nestjs/common';
import type { LlmMessage } from '../../llm/llm.types';
import {
  AgentStrategyMode,
  type AgentLoopInput,
  type AgentStrategyDecision,
} from './agent-loop.types';
import {
  CapabilityRegistry,
  DEFAULT_TOOL_GROUP,
} from './capability/capability.registry';

const DEFAULT_MAX_STEPS = 6;

// 仅保留有真实工具支撑的意图关键词，避免路由承诺出并不存在的能力。
const TOOL_INTENT_KEYWORDS = [
  '天气',
  '气温',
  '温度',
  '下雨',
  '降雨',
  '降水',
  '气象',
  '预报',
  '查一下',
  '查询',
  '调用工具',
];

const PLAN_INTENT_KEYWORDS = [
  '计划',
  '步骤',
  '流程',
  '方案',
  '规划',
  '拆解',
  '对接',
  '实现',
  '重构',
];

const HYBRID_INTENT_KEYWORDS = [
  '一边',
  '同时',
  '多阶段',
  '复杂',
  '动态',
  '根据结果',
  '再决定',
];

@Injectable()
export class StrategyRouterService {
  constructor(private readonly registry: CapabilityRegistry) {}

  /**
   * 选择 agent loop 执行策略
   * @param input agent loop 输入上下文
   * @returns 返回本次任务的策略决策
   * @description 第一版使用保守规则路由，避免新增一次模型路由调用影响当前聊天稳定性；后续可替换为结构化输出模型路由。工具可用性以能力注册表为准。
   */
  route(input: AgentLoopInput): AgentStrategyDecision {
    const latestUserText = this.readLatestUserText(input.messages);
    const hasTools = this.registry.hasTools();
    const hasToolIntent = this.includesAny(
      latestUserText,
      TOOL_INTENT_KEYWORDS,
    );
    const hasPlanIntent = this.includesAny(
      latestUserText,
      PLAN_INTENT_KEYWORDS,
    );
    const hasHybridIntent = this.includesAny(
      latestUserText,
      HYBRID_INTENT_KEYWORDS,
    );

    if (hasTools && hasPlanIntent && hasHybridIntent) {
      return this.buildDecision({
        mode: AgentStrategyMode.Hybrid,
        confidence: 0.72,
        reason: '请求同时包含多步骤规划和动态工具探索意图',
        publicStatus: '正在规划任务并准备按步骤处理',
      });
    }

    if (hasPlanIntent && latestUserText.length > 80) {
      return this.buildDecision({
        mode: AgentStrategyMode.PlanExecute,
        confidence: 0.68,
        reason: '请求较长且包含规划、流程或实现类关键词',
        publicStatus: '正在拆解任务步骤',
      });
    }

    if (hasTools && hasToolIntent) {
      return this.buildDecision({
        mode: AgentStrategyMode.ReAct,
        confidence: 0.74,
        reason: '请求包含需要外部工具协助的意图',
        publicStatus: '正在准备调用工具',
        toolGroups: [DEFAULT_TOOL_GROUP],
      });
    }

    return this.buildDecision({
      mode: AgentStrategyMode.Direct,
      confidence: 0.78,
      reason: '请求可通过直接生成回答完成',
      publicStatus: '正在生成回复',
    });
  }

  private buildDecision(
    decision: Pick<
      AgentStrategyDecision,
      'mode' | 'confidence' | 'reason' | 'publicStatus'
    > &
      Partial<
        Pick<AgentStrategyDecision, 'skills' | 'toolGroups' | 'maxSteps'>
      >,
  ): AgentStrategyDecision {
    return {
      mode: decision.mode,
      confidence: decision.confidence,
      reason: decision.reason,
      skills: decision.skills ?? [],
      toolGroups: decision.toolGroups ?? [],
      maxSteps: decision.maxSteps ?? DEFAULT_MAX_STEPS,
      publicStatus: decision.publicStatus,
    };
  }

  private readLatestUserText(messages: LlmMessage[]) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === 'user') {
        return message.content;
      }
    }

    return '';
  }

  private includesAny(text: string, keywords: string[]) {
    return keywords.some((keyword) => text.includes(keyword));
  }
}
