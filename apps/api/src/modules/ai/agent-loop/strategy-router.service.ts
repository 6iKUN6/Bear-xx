import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../../llm/llm.service';
import { KIMI_PLATFORM } from '../../llm/providers/kimi';
import type { LlmMessage } from '../../llm/llm.types';
import { z } from 'zod';
import {
  AgentStrategyMode,
  type AgentDefinition,
  type AgentLoopInput,
  type AgentStrategyDecision,
} from './agent-loop.types';
import {
  CapabilityRegistry,
  DEFAULT_TOOL_GROUP,
} from './capability/capability.registry';

const DEFAULT_MAX_STEPS = 6;
const MAX_STEPS_LIMIT = 10;

/**
 * 策略决策输出契约
 * @description mode 用宽松 string 而非 enum：模型常给 `react_agent`/`planExecute` 等别名，
 * 交由 normalizeMode 归一后再做闭集校验，比让 schema 直接拒绝更宽容（拒绝=整轮降级到规则）。
 * toolGroups/skills 同理只约束为字符串数组，具体值由注册表闭集收敛。
 */
const strategyDecisionSchema = z.object({
  mode: z.string().describe('direct | react | plan_execute | hybrid'),
  toolGroups: z.array(z.string()).optional().describe('从可用工具组中选择'),
  skills: z.array(z.string()).optional().describe('从可用技能中选择'),
  maxSteps: z.number().optional(),
  confidence: z.number().optional(),
  reason: z.string().optional().describe('简述理由'),
});

type StrategyDecisionOutput = z.infer<typeof strategyDecisionSchema>;

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
    const cfg = input.agentConfig;

    // agent 强制指定具体策略：跳过 LLM/规则路由，确定性 + 省一次调用。
    if (cfg && cfg.defaultStrategy !== 'auto') {
      return this.applyAgentOverrides(this.buildForcedDecision(cfg), cfg);
    }

    let decision: AgentStrategyDecision | null = null;
    if (this.isModelRouterEnabled()) {
      try {
        decision = await this.routeByModel(input);
        if (!decision) {
          // 调用成功但输出不合法（解析失败/mode 非法），同样是降级，需可观测
          this.logger.warn('LLM 路由输出不合法，降级关键词规则');
        }
      } catch (error) {
        this.logger.warn(
          `LLM 路由失败，降级关键词规则：${(error as Error).message}`,
        );
      }
    }

    decision = decision ?? this.routeByRules(input);
    return cfg ? this.applyAgentOverrides(decision, cfg) : decision;
  }

  /**
   * 构建强制策略决策（agent defaultStrategy 为具体值时）
   * @param cfg 智能体配置
   * @returns 返回不经消息路由的决策
   * @description mode 取配置的具体策略并 clamp 到 allowedStrategies；工具组用 forcedDefaultToolGroups 兜底，
   * 避免带工具的策略拿不到工具。供 route() 与 resume 复用（故为 public）。
   */
  buildForcedDecision(cfg: AgentDefinition): AgentStrategyDecision {
    const requested =
      this.strategyToMode(cfg.defaultStrategy) ?? AgentStrategyMode.Direct;
    const mode = this.clampModeToAllowed(requested, cfg);
    return {
      mode,
      confidence: 1,
      reason: 'agent 配置强制指定执行策略',
      skills: [],
      toolGroups: this.forcedDefaultToolGroups(mode, cfg),
      maxSteps: DEFAULT_MAX_STEPS,
      publicStatus: PUBLIC_STATUS_BY_MODE[mode],
      source: 'forced',
    };
  }

  /**
   * 构建 HITL 恢复用决策（config-only，不经消息路由）
   * @param cfg 智能体配置（可空 = 默认 agent）
   * @returns 返回仅用于装配能力的决策
   * @description resume 不跑策略图，只需 toolGroups/skills 供 CapabilityResolver 装配。工具组按配置取，
   * 空则兜底默认组（恢复本质是执行工具）；对默认 agent 与旧的"全量工具"行为等价（两工具同属默认组）。
   */
  buildResumeDecision(cfg?: AgentDefinition): AgentStrategyDecision {
    return {
      mode: AgentStrategyMode.ReAct,
      confidence: 1,
      reason: 'HITL 恢复：按 agent 配置装配能力',
      skills: cfg ? this.filterKnownSkills(cfg.skills) : [],
      toolGroups: this.resumeToolGroups(cfg),
      maxSteps:
        cfg && cfg.maxSteps != null
          ? this.clampMaxSteps(cfg.maxSteps)
          : DEFAULT_MAX_STEPS,
      publicStatus: PUBLIC_STATUS_BY_MODE[AgentStrategyMode.ReAct],
      source: 'resume',
    };
  }

  /**
   * 将 agent 配置覆盖叠加到决策上
   * @param decision 基础决策（路由或强制）
   * @param cfg 智能体配置
   * @returns 返回叠加后的决策
   * @description 语义为"空/null = 不覆盖"：仅非空 toolGroups/skills、非 null maxSteps 才覆盖；
   * allowedStrategies 非空时把 mode clamp 到允许集合内。
   */
  private applyAgentOverrides(
    decision: AgentStrategyDecision,
    cfg: AgentDefinition,
  ): AgentStrategyDecision {
    const next: AgentStrategyDecision = { ...decision };

    if (cfg.toolGroups.length > 0) {
      next.toolGroups = this.filterKnownToolGroups(cfg.toolGroups);
    }
    if (cfg.skills.length > 0) {
      next.skills = this.filterKnownSkills(cfg.skills);
    }
    if (cfg.maxSteps != null) {
      next.maxSteps = this.clampMaxSteps(cfg.maxSteps);
    }

    const clampedMode = this.clampModeToAllowed(next.mode, cfg);
    if (clampedMode !== next.mode) {
      next.mode = clampedMode;
      next.publicStatus = PUBLIC_STATUS_BY_MODE[clampedMode];
    }

    return next;
  }

  /** 'auto' → undefined；具体策略 → 对应 mode */
  private strategyToMode(
    strategy: AgentDefinition['defaultStrategy'],
  ): AgentStrategyMode | undefined {
    return strategy === 'auto' ? undefined : strategy;
  }

  /**
   * 将 mode 收敛到 allowedStrategies 内
   * @description allowed 为空 = 不限制，原样返回；否则命中则保留，未命中回落到
   * 具体 defaultStrategy（若在 allowed 内）否则 allowed[0] 否则 direct。
   */
  private clampModeToAllowed(
    mode: AgentStrategyMode,
    cfg: AgentDefinition,
  ): AgentStrategyMode {
    if (
      cfg.allowedStrategies.length === 0 ||
      cfg.allowedStrategies.includes(mode)
    ) {
      return mode;
    }
    const concreteDefault = this.strategyToMode(cfg.defaultStrategy);
    if (concreteDefault && cfg.allowedStrategies.includes(concreteDefault)) {
      return concreteDefault;
    }
    return cfg.allowedStrategies[0] ?? AgentStrategyMode.Direct;
  }

  /** 过滤到注册表已存在的工具组闭集 */
  private filterKnownToolGroups(groups: string[]): string[] {
    const known = new Set(this.registry.listToolGroups());
    return groups.filter((group) => known.has(group));
  }

  /**
   * 强制模式的工具组兜底
   * @description 显式配置优先；否则非 Direct 且有默认组时兜底默认组，避免带工具模式零工具。
   */
  private forcedDefaultToolGroups(
    mode: AgentStrategyMode,
    cfg: AgentDefinition,
  ): string[] {
    if (cfg.toolGroups.length > 0) {
      return this.filterKnownToolGroups(cfg.toolGroups);
    }
    const known = new Set(this.registry.listToolGroups());
    if (
      mode !== AgentStrategyMode.Direct &&
      this.registry.hasTools() &&
      known.has(DEFAULT_TOOL_GROUP)
    ) {
      return [DEFAULT_TOOL_GROUP];
    }
    return [];
  }

  /** 恢复路径工具组：配置优先，空则兜底默认组（恢复即执行工具） */
  private resumeToolGroups(cfg?: AgentDefinition): string[] {
    if (cfg && cfg.toolGroups.length > 0) {
      return this.filterKnownToolGroups(cfg.toolGroups);
    }
    const known = new Set(this.registry.listToolGroups());
    return this.registry.hasTools() && known.has(DEFAULT_TOOL_GROUP)
      ? [DEFAULT_TOOL_GROUP]
      : [];
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

    const parsed = await this.llmService.generateStructured(
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
      strategyDecisionSchema,
      {
        schemaName: 'strategy_decision',
        // 不覆盖 temperature：部分模型（如 kimi-for-coding）仅允许 temperature=1。
        request: { model: { platform: KIMI_PLATFORM } },
        abortSignal: input.abortSignal,
      },
    );

    return this.buildDecisionFromModel(parsed);
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
  private buildDecisionFromModel(
    parsed: StrategyDecisionOutput | null,
  ): AgentStrategyDecision | null {
    if (!parsed) {
      return null;
    }

    // schema 保证了形状，这里做闭集收敛：mode 别名归一 + toolGroups/skills 收敛到注册表
    const mode = this.normalizeMode(parsed.mode);
    if (!mode) {
      return null;
    }

    return {
      mode,
      confidence: this.clampConfidence(parsed.confidence),
      reason:
        this.readString(parsed.reason) ?? '由结构化路由模型决策得到的执行策略',
      skills: this.filterKnownSkills(parsed.skills),
      toolGroups: this.resolveToolGroups(mode, parsed.toolGroups),
      maxSteps: this.clampMaxSteps(parsed.maxSteps),
      publicStatus: PUBLIC_STATUS_BY_MODE[mode],
      source: 'model',
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
      // 该工厂仅服务关键词规则路由（LLM 路由走 parseDecision 自行标记）
      source: 'rules',
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
