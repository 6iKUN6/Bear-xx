import {
  calculateFlowDefinitionDigest,
  createFlowDefinitionPreset,
  validateFlowDefinition,
} from './flow-definition.validator';

describe('FlowDefinitionValidator', () => {
  it('忽略 layout 与对象字段顺序，生成稳定的语义摘要', () => {
    const first = validDefinition();
    const second = {
      kind: 'agent-flow',
      description: first.description,
      schemaVersion: 1,
      name: first.name,
      policy: {
        maxDurationSeconds: 900,
        maxToolCalls: 12,
        maxModelCalls: 8,
        maxSteps: 5,
      },
      nodes: first.nodes,
      edges: first.edges,
      layout: {
        nodes: {
          plan: { x: 720, y: 24 },
          answer: { x: 1024, y: 480 },
        },
      },
    };

    const firstResult = validateFlowDefinition(first);
    const secondResult = validateFlowDefinition(second);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    if (!firstResult.success || !secondResult.success) {
      throw new Error('有效 FlowDefinition 不应校验失败');
    }
    expect(calculateFlowDefinitionDigest(firstResult.definition)).toBe(
      calculateFlowDefinitionDigest(secondResult.definition),
    );
  });

  it('拒绝未知节点类型，并返回可展示的字段路径', () => {
    const result = validateFlowDefinition({
      ...validDefinition(),
      nodes: [{ id: 'unsupported', type: 'unsupported', config: {} }],
    });

    expectValidationError(
      result,
      (error) => error.path === 'nodes.0.type' && error.rule === 'schema',
    );
  });

  it('拒绝普通节点形成的环，但允许 plan-loop 作为受控内部循环节点', () => {
    const cyclic = {
      ...validDefinition(),
      nodes: [
        {
          id: 'agent-a',
          type: 'agent',
          config: { toolGroups: [], skills: [], maxToolIterations: 1 },
        },
        { id: 'answer', type: 'synthesize', config: {} },
      ],
      edges: [
        { from: 'agent-a', to: 'answer' },
        { from: 'answer', to: 'agent-a' },
      ],
    };

    const cyclicResult = validateFlowDefinition(cyclic);
    const planLoopResult = validateFlowDefinition(validDefinition());

    expectValidationError(cyclicResult, (error) => error.rule === 'cycle');
    expect(planLoopResult.success).toBe(true);
  });

  it('拒绝引用不存在节点的边', () => {
    const result = validateFlowDefinition({
      ...validDefinition(),
      edges: [{ from: 'plan', to: 'missing' }],
    });

    expectValidationError(
      result,
      (error) =>
        error.path === 'edges.0.to' && error.rule === 'edge-node-exists',
    );
  });

  it('拒绝前面没有 plan 节点的 plan-loop', () => {
    // 运行时会抛 AGENT_FLOW_PLAN_STATE_MISSING，必须在发布期就拦住
    const definition = validDefinition();
    const result = validateFlowDefinition({
      ...definition,
      nodes: definition.nodes.filter((node) => node.id !== 'plan'),
      edges: [
        { from: 'review', to: 'execute', when: 'approved' },
        { from: 'execute', to: 'answer' },
      ],
    });

    expectValidationError(
      result,
      (error) => error.rule === 'plan-prerequisite',
    );
  });

  it('拒绝前面没有 plan 节点的计划审批', () => {
    const definition = validDefinition();
    const result = validateFlowDefinition({
      ...definition,
      nodes: definition.nodes.filter(
        (node) => node.id !== 'plan' && node.id !== 'execute',
      ),
      edges: [{ from: 'review', to: 'answer', when: 'approved' }],
    });

    expectValidationError(
      result,
      (error) =>
        error.rule === 'plan-prerequisite' && error.path === 'nodes.0.id',
    );
  });

  it('plan 在链路更早处时依赖计划的节点通过校验', () => {
    const definition = validDefinition();
    const result = validateFlowDefinition(definition);

    expect(result.success).toBe(true);
  });

  it.each(['direct', 'react', 'plan_execute', 'hybrid'] as const)(
    '%s 预设通过与导入 JSON 相同的校验器',
    (preset) => {
      const result = validateFlowDefinition(createFlowDefinitionPreset(preset));

      expect(result.success).toBe(true);
    },
  );
});

/**
 * 构造带计划审批和 PlanLoop 的合法 FlowDefinition 原始 JSON
 * @returns 返回仅用于验证器输入的结构化 JSON 对象
 * @description 以文档中的 Plan Execute 形状覆盖入口、终点、节点闭集与条件边校验。
 */
function validDefinition() {
  return {
    schemaVersion: 1,
    kind: 'agent-flow',
    name: '研究并回复',
    description: '先规划，再使用受限工具完成步骤并汇总',
    policy: {
      maxSteps: 5,
      maxModelCalls: 8,
      maxToolCalls: 12,
      maxDurationSeconds: 900,
    },
    nodes: [
      { id: 'plan', type: 'plan', config: { maxSteps: 5 } },
      {
        id: 'review',
        type: 'approval',
        config: { kind: 'plan-review' },
      },
      {
        id: 'execute',
        type: 'plan-loop',
        config: {
          executor: {
            type: 'agent',
            modelPreset: 'agent-default',
            toolGroups: ['weather'],
            skills: [],
            maxToolIterations: 4,
          },
          stopPolicy: 'all-steps',
        },
      },
      { id: 'answer', type: 'synthesize', config: {} },
    ],
    edges: [
      { from: 'plan', to: 'review' },
      { from: 'review', to: 'execute', when: 'approved' },
      { from: 'execute', to: 'answer' },
    ],
    layout: { nodes: { plan: { x: 80, y: 120 } } },
  };
}

/**
 * 断言校验结果中包含指定的结构化错误
 * @param result FlowDefinition 校验结果
 * @param predicate 对单个校验错误的匹配条件
 * @returns 无返回值
 * @description 先收窄失败分支再读取 errors，避免 Jest 非类型安全匹配器掩盖新增协议的字段错误。
 */
function expectValidationError(
  result: ReturnType<typeof validateFlowDefinition>,
  predicate: (error: {
    path: string;
    rule: string;
    message: string;
  }) => boolean,
): void {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error('预期 FlowDefinition 校验失败');
  }
  expect(result.errors.some(predicate)).toBe(true);
}
