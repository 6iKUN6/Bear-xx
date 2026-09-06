import { Injectable } from '@nestjs/common';
import type { Agent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { type AgentDefinition } from '../ai/agent-loop/agent-loop.types';

/**
 * @deprecated 旧编排链路，**已不可达**，等待删除。
 *
 * Flow 已成为唯一编排路径：`resolveTaskFlowSnapshot` 现在总会给聊天任务锁定一份
 * Definition（Agent 绑了用它的，没绑用内置 direct Flow），因此 `ensureTaskExecution`
 * 永远走 Flow 分支，`runChatTask` 及其下游整条链都进不去。
 *
 * 保留数个版本再删，不是因为还有用，而是给回滚留余地。删除时机与边界见
 * `apps/api/docs/agent-flow-as-single-runtime.md` §2、§7。
 *
 * 不要在这里加新功能，也不要把它当作「长短任务分流」的复用基础——那条路要基于
 * Flow 的 activities 重写，与本链路无关。
 */

const DEFAULT_CACHE_KEY = '__default__';

/** Prisma AgentStrategy → 内部 AgentStrategyMode（AUTO 无对应，单独处理） */
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
   */
  private toDefinition(row: Agent): AgentDefinition {
    // 策略、工具组、技能、步数四类字段的数据库列已随方案 A 删除（工具只在 Flow 节点上
    // 声明）。本链路已不可达，因此这里让它们保持「不覆盖」缺省值，只为让这段废弃代码继续
    // 编译——不代表运行时还有这套语义。整条链删除时这个方法一并消失。
    return {
      ...SYNTHETIC_DEFAULT,
      systemPrompt: row.systemPrompt,
      modelPreset: null,
    };
  }
}
