import type { FlowDefinition } from '@litter-bear/types/agent-flow';

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
