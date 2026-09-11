import type { Prisma } from '@prisma/client';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { normalizeFlowDefinition } from './flow-definition.versioning';

/**
 * 汇总一张 Flow 图上声明的全部工具组
 * @param definition 已通过结构校验的 Definition
 * @returns 返回去重并排序后的工具组名
 * @description 供智能体列表展示「这个智能体能用哪些工具」。收敛后工具只在 Flow 节点上声明，
 * `Agent.toolGroups` 那一列已不驱动执行，因此展示也必须改从图上取，否则界面显示的和实际
 * 能调的会长期不一致。
 *
 * 带工具的位置有两处：agent 节点自身，以及 plan-loop 的内部 executor。
 *
 * 刻意不含 skills 展开出的工具：skills 展开的是**具体工具名**（`CapabilityRegistry.getSkill`
 * 返回 toolNames），不是工具组，混进来会让这个列表的语义变成"组名和工具名混排"。
 *
 * 排序是为了让展示稳定：Definition 里节点顺序变化不该让标签顺序跟着跳。
 */
export function collectFlowToolGroups(
  definition: FlowDefinition,
): readonly string[] {
  const groups = new Set<string>();
  for (const node of definition.nodes) {
    if (node.type === 'agent') {
      for (const group of node.config.toolGroups) {
        groups.add(group);
      }
    } else if (node.type === 'plan-loop') {
      for (const group of node.config.executor.toolGroups) {
        groups.add(group);
      }
    }
  }
  return [...groups].sort();
}

/**
 * 从绑定的 FlowVersion 原文推导工具组
 * @param boundDefinition 绑定 FlowVersion 的 Definition JSON；未绑定时为空
 * @returns 返回可直接展示的工具组名
 * @description 三处消费同一份推导：智能体列表的能力标签、群聊选人提示词里的「成员擅长
 * 什么」、以及群聊语境注入的花名册。抄三遍必然漂移。
 *
 * 未绑定 Flow 的智能体执行内置 direct Flow（不带工具），因此为空。
 *
 * Definition 解析失败时返回空而不是抛错：这三处都是**展示与提示词**用途，为了它让智能体
 * 列表报错、或让整个群聊选不出人，代价远大于少显示一行能力。真正的契约不兼容会在任务创建
 * 与画布读取时被明确拒绝。
 */
export function resolveBoundFlowToolGroups(
  boundDefinition: Prisma.JsonValue | null | undefined,
): string[] {
  if (!boundDefinition) {
    return [];
  }
  const parsed = normalizeFlowDefinition(boundDefinition);
  return parsed.success ? [...collectFlowToolGroups(parsed.definition)] : [];
}
