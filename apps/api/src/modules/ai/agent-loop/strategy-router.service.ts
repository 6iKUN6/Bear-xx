import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../../llm/llm.service';
import { KIMI_PLATFORM } from '../../llm/providers/kimi';
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
const MAX_STEPS_LIMIT = 10;

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

const PUBLIC_STATUS_BY_MODE: Record<AgentStrategyMode, string> = {
  [AgentStrategyMode.Direct]: '正在生成回复',
  [AgentStrategyMode.ReAct]: '正在准备调用工具',
  [AgentStrategyMode.PlanExecute]: '正在拆解任务步骤',
  [AgentStrategyMode.Hybrid]: '正在规划任务并准备按步骤处理',
};

@Injectable()
export class StrategyRouterService {
  private readonly logger = new Logger(StrategyRouterService.name);

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 选择 agent loop 执行策略
   * @param input agent loop 输入上下文
   * @returns 返回本次任务的策略决策
   * @description 优先用结构化 LLM 决策 agent 路由（约束在能力注册表闭集内）；
   * 关闭开关、模型失败或输出非法时，降级为保守关键词规则路由，保证主链路稳定。
   */
  async route(input: AgentLoopInput): Promise<AgentStrategyDecision> {
    if (this.isModelRouterEnabled()) {
      try {
        const decision = await this.routeByModel(input);
        if (decision) {
          return decision;
        }
      } catch (error) {
        this.logger.warn(
          `LLM 路由失败，降级关键词规则：${(error as Error).message}`,
        );
      }
    }

    return this.routeByRules(input);
  }

  /**
   * 结构化 LLM 路由
   * @param input agent loop 输入上下文
   * @returns 返回模型决策；无法解析或校验失败时返回 null（触发规则降级）
   * @description 用 Kimi 预设产出结构化决策，并对 mode/toolGroups/skills 做闭集校验与兜底。
   */
  private async routeByModel(
    input: AgentLoopInput,
  ): Promise<AgentStrategyDecision | null> {
    const latestUserText = this.readLatestUserText(input.messages);
    if (!latestUserText.trim()) {
      return null;
    }

    const toolGroups = this.registry.listToolGroups();
    const toolNames = this.registry.listToolNames();
    const skillNames = this.registry.listSkillNames();

    const raw = await this.llmService.generateChatText(
      [
        { role: 'system', content: this.buildRouterSystemPrompt() },
        {
          role: 'user',
          content: this.buildRouterUserPrompt(
            latestUserText,
            toolGroups,
            toolNames,
            skillNames,
          ),
        },
      ],
      // 不覆盖 temperature：部分模型（如 kimi-for-coding）仅允许 temperature=1。
      { model: { platform: KIMI_PLATFORM } },
      { abortSignal: input.abortSignal },
    );

    return this.parseDecision(raw);
  }

  private buildRouterSystemPrompt(): string {
    return [
      '你是一个对话策略路由器。判断用户请求应使用哪种执行策略，只输出 JSON，禁止解释或 Markdown。',
      '可选策略 mode：',
      '- direct：可直接回答，无需工具或多步骤。',
      '- react：需要调用工具（如查询天气）一步到位。',
      '- plan_execute：任务较复杂，需要先拆解为多步骤再依次执行。',
      '- hybrid：任务复杂且需要根据中间结果动态调整，边规划边用工具。',
      '输出格式：{"mode":"direct|react|plan_execute|hybrid","toolGroups":[],"skills":[],"maxSteps":6,"confidence":0.0,"reason":"简述理由"}',
      'toolGroups/skills 只能从"可用能力"中选择；没有合适的就给空数组。',
    ].join('\n');
  }

  private buildRouterUserPrompt(
    userText: string,
    toolGroups: string[],
    toolNames: string[],
    skillNames: string[],
  ): string {
    return [
      `用户请求：\n${userText}`,
      `可用工具组：${toolGroups.length ? toolGroups.join('、') : '（无）'}`,
      `可用工具：${toolNames.length ? toolNames.join('、') : '（无）'}`,
      `可用技能：${skillNames.length ? skillNames.join('、') : '（无）'}`,
    ].join('\n\n');
  }

  /**
   * 解析并校验模型决策
   * @param raw 模型原始输出
   * @returns 返回合法决策；无法解析或 mode 非法时返回 null
   * @description 对 mode 做别名归一与枚举校验，toolGroups/skills 收敛到注册表闭集，maxSteps/confidence 做区间约束。
   */
  private parseDecision(raw: string): AgentStrategyDecision | null {
    const json = this.extractJson(raw);
    if (!json) {
      return null;
    }

    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(json);
      if (!value || typeof value !== 'object') {
        return null;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      return null;
    }

    const mode = this.normalizeMode(parsed.mode);
    if (!mode) {
      return null;
    }

    const toolGroups = this.resolveToolGroups(mode, parsed.toolGroups);
    const skills = this.filterKnownSkills(parsed.skills);

    return {
      mode,
      confidence: this.clampConfidence(parsed.confidence),
      reason:
        this.readString(parsed.reason) ?? '由结构化路由模型决策得到的执行策略',
      skills,
      toolGroups,
      maxSteps: this.clampMaxSteps(parsed.maxSteps),
      publicStatus: PUBLIC_STATUS_BY_MODE[mode],
    };
  }

  private normalizeMode(value: unknown): AgentStrategyMode | undefined {
    const text = this.readString(value)?.toLowerCase();
    switch (text) {
      case 'direct':
        return AgentStrategyMode.Direct;
      case 'react':
      case 'react_agent':
        return AgentStrategyMode.ReAct;
      case 'plan':
      case 'plan_execute':
      case 'planexecute':
        return AgentStrategyMode.PlanExecute;
      case 'hybrid':
        return AgentStrategyMode.Hybrid;
      default:
        return undefined;
    }
  }

  /**
   * 收敛工具组到闭集，并对非 direct 模式做兜底
   * @description 过滤掉注册表中不存在的工具组；react/plan/hybrid 若最终为空且存在可用工具，则兜底为默认工具组，避免带工具的策略拿不到工具。
   */
  private resolveToolGroups(mode: AgentStrategyMode, value: unknown): string[] {
    const known = new Set(this.registry.listToolGroups());
    const requested = Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === 'string' && known.has(item),
        )
      : [];

    if (
      requested.length === 0 &&
      mode !== AgentStrategyMode.Direct &&
      this.registry.hasTools() &&
      known.has(DEFAULT_TOOL_GROUP)
    ) {
      return [DEFAULT_TOOL_GROUP];
    }

    return requested;
  }

  private filterKnownSkills(value: unknown): string[] {
    const known = new Set(this.registry.listSkillNames());
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (item): item is string => typeof item === 'string' && known.has(item),
    );
  }

  private clampConfidence(value: unknown): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return 0.6;
    }
    return Math.min(1, Math.max(0, value));
  }

  private clampMaxSteps(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_MAX_STEPS;
    }
    return Math.min(MAX_STEPS_LIMIT, Math.max(1, Math.round(value)));
  }

  private extractJson(raw: string): string | undefined {
    if (!raw) {
      return undefined;
    }
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return undefined;
    }
    return body.slice(start, end + 1);
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private isModelRouterEnabled(): boolean {
    const value = this.configService.get<string>('LLM_ROUTER_ENABLED');
    // 默认开启；显式设为 false/0 时关闭。
    return value !== 'false' && value !== '0';
  }

  /**
   * 关键词规则路由（降级方案）
   * @param input agent loop 输入上下文
   * @returns 返回基于关键词的保守策略决策
   * @description 不调用模型，依据最后一条用户消息的关键词与长度选择策略；工具可用性以能力注册表为准。
   */
  private routeByRules(input: AgentLoopInput): AgentStrategyDecision {
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
        publicStatus: PUBLIC_STATUS_BY_MODE[AgentStrategyMode.Hybrid],
        toolGroups: [DEFAULT_TOOL_GROUP],
      });
    }

    if (hasPlanIntent && latestUserText.length > 80) {
      return this.buildDecision({
        mode: AgentStrategyMode.PlanExecute,
        confidence: 0.68,
        reason: '请求较长且包含规划、流程或实现类关键词',
        publicStatus: PUBLIC_STATUS_BY_MODE[AgentStrategyMode.PlanExecute],
        toolGroups: hasTools ? [DEFAULT_TOOL_GROUP] : [],
      });
    }

    if (hasTools && hasToolIntent) {
      return this.buildDecision({
        mode: AgentStrategyMode.ReAct,
        confidence: 0.74,
        reason: '请求包含需要外部工具协助的意图',
        publicStatus: PUBLIC_STATUS_BY_MODE[AgentStrategyMode.ReAct],
        toolGroups: [DEFAULT_TOOL_GROUP],
      });
    }

    return this.buildDecision({
      mode: AgentStrategyMode.Direct,
      confidence: 0.78,
      reason: '请求可通过直接生成回答完成',
      publicStatus: PUBLIC_STATUS_BY_MODE[AgentStrategyMode.Direct],
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
