import { Injectable } from '@nestjs/common';
import { AgentStrategy, type Agent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AgentStrategyMode,
  type AgentDefaultStrategy,
  type AgentDefinition,
} from '../ai/agent-loop/agent-loop.types';

const DEFAULT_CACHE_KEY = '__default__';

/** Prisma AgentStrategy → 内部 AgentStrategyMode（AUTO 无对应，单独处理） */
const STRATEGY_MODE_MAP: Record<
  Exclude<AgentStrategy, 'AUTO'>,
  AgentStrategyMode
> = {
  [AgentStrategy.DIRECT]: AgentStrategyMode.Direct,
  [AgentStrategy.REACT]: AgentStrategyMode.ReAct,
  [AgentStrategy.PLAN_EXECUTE]: AgentStrategyMode.PlanExecute,
  [AgentStrategy.HYBRID]: AgentStrategyMode.Hybrid,
};

/** DB 无 agent 时的合成默认定义：全部"不覆盖"，复刻当前默认行为 */
const SYNTHETIC_DEFAULT: AgentDefinition = {
  systemPrompt: null,
  modelPreset: null,
  defaultStrategy: 'auto',
  allowedStrategies: [],
  toolGroups: [],
  skills: [],
  maxSteps: null,
};

/**
 * 运行时智能体定义解析
 * @description 按 agentId（或 isDefault）从 DB 载入并映射为执行链路消费的 AgentDefinition；
 * DB 无匹配（如未 seed / agent 被禁用 / id 不存在）时回退合成默认值，保证未 seed 也能正常跑。
 * 结果会话级缓存，写操作经 AgentService 调用 invalidate() 失效。
 */
@Injectable()
export class AgentDefinitionService {
  private readonly cache = new Map<string, AgentDefinition>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 解析智能体定义
   * @param agentId 指定智能体 id；缺省则用 isDefault
   * @returns 返回可驱动执行链路的定义（永不抛错，缺失回退合成默认）
   */
  async resolve(agentId?: string | null): Promise<AgentDefinition> {
    const key = agentId ?? DEFAULT_CACHE_KEY;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const row = agentId
      ? await this.prisma.agent.findFirst({
          where: { id: agentId, enabled: true },
        })
      : await this.prisma.agent.findFirst({
          where: { isDefault: true, enabled: true },
        });

    const definition = row ? this.toDefinition(row) : SYNTHETIC_DEFAULT;
    this.cache.set(key, definition);
    return definition;
  }

  /** 清空缓存（agent 写操作后调用） */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Prisma 行 → 内部定义
   * @description 枚举转小写 mode；allowedStrategies 过滤掉 AUTO（仅具体策略有意义）。
   */
  private toDefinition(row: Agent): AgentDefinition {
    return {
      systemPrompt: row.systemPrompt,
      modelPreset: row.modelPreset,
      defaultStrategy: this.toDefaultStrategy(row.defaultStrategy),
      allowedStrategies: row.allowedStrategies
        .filter(
          (s): s is Exclude<AgentStrategy, 'AUTO'> => s !== AgentStrategy.AUTO,
        )
        .map((s) => STRATEGY_MODE_MAP[s]),
      toolGroups: row.toolGroups,
      skills: row.skills,
      maxSteps: row.maxSteps,
    };
  }

  private toDefaultStrategy(value: AgentStrategy): AgentDefaultStrategy {
    return value === AgentStrategy.AUTO ? 'auto' : STRATEGY_MODE_MAP[value];
  }
}
