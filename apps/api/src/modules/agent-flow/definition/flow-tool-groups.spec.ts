import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { collectFlowToolGroups } from './flow-tool-groups';
import { createFlowDefinitionPreset } from './flow-definition.templates';

/**
 * 工具组推导
 * @description 智能体列表上的工具标签靠它。收敛后 `Agent.toolGroups` 已不驱动执行，
 * 若展示仍读那一列，界面显示的和实际能调的会长期不一致。
 */
describe('collectFlowToolGroups', () => {
  /**
   * 用内置预设做底，替换节点后返回
   * @param nodes 覆盖用的节点集合
   * @returns 返回仅供本用例使用的 Definition
   */
  function withNodes(nodes: unknown[]): FlowDefinition {
    return {
      ...createFlowDefinitionPreset('direct'),
      nodes,
    } as unknown as FlowDefinition;
  }

  it('内置 direct 预设不带工具', () => {
    // 未绑定 Flow 的智能体执行的就是它；标签为空是事实，不是漏读
    expect(collectFlowToolGroups(createFlowDefinitionPreset('direct'))).toEqual(
      [],
    );
  });

  it('ReAct 预设带出默认工具组', () => {
    expect(collectFlowToolGroups(createFlowDefinitionPreset('react'))).toEqual([
      'default',
    ]);
  });

  it('多个 agent 节点的工具组去重并排序', () => {
    // 排序是为了展示稳定：节点顺序变化不该让标签顺序跟着跳
    const definition = withNodes([
      { id: 'start', type: 'start', config: {} },
      {
        id: 'b',
        type: 'agent',
        config: {
          modelPreset: 'agent-default',
          toolGroups: ['weather', 'default'],
          skills: [],
          maxToolIterations: 1,
        },
      },
      {
        id: 'a',
        type: 'agent',
        config: {
          modelPreset: 'agent-default',
          toolGroups: ['default', 'search'],
          skills: [],
          maxToolIterations: 1,
        },
      },
    ]);

    expect(collectFlowToolGroups(definition)).toEqual([
      'default',
      'search',
      'weather',
    ]);
  });

  it('算上 plan-loop 内部 executor 的工具组', () => {
    // plan-loop 的工具挂在 config.executor 上而不是 config 上，漏掉它会让
    // plan_execute 这类图的标签少一半
    const definition = withNodes([
      { id: 'start', type: 'start', config: {} },
      {
        id: 'execute',
        type: 'plan-loop',
        config: {
          planRef: { $ref: ['plan', 'steps'] },
          stopPolicy: 'all-steps',
          executor: {
            type: 'agent',
            modelPreset: 'agent-default',
            toolGroups: ['search'],
            skills: [],
            maxToolIterations: 2,
          },
        },
      },
    ]);

    expect(collectFlowToolGroups(definition)).toEqual(['search']);
  });

  it('不把 skills 混进来', () => {
    // skills 展开的是具体工具名而不是工具组；混进来会让这个列表变成「组名和工具名混排」
    const definition = withNodes([
      { id: 'start', type: 'start', config: {} },
      {
        id: 'a',
        type: 'agent',
        config: {
          modelPreset: 'agent-default',
          toolGroups: [],
          skills: ['imageGeneration'],
          maxToolIterations: 1,
        },
      },
    ]);

    expect(collectFlowToolGroups(definition)).toEqual([]);
  });
});
