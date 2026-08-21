import { AGENT_FLOW_SCHEMA_VERSION } from '@litter-bear/types/agent-flow';
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
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
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

  it('拒绝 V1 工件，不做双运行时兼容', () => {
    expectValidationError(
      validateFlowDefinition({ ...validDefinition(), schemaVersion: 1 }),
      (error) => error.rule === 'schema',
    );
  });

  it('接受引用支配节点的条件分支', () => {
    // classify 的每条入边都必经 plan，因此 plan.stepCount 一定已产出
    const result = validateFlowDefinition(conditionDefinition());

    expect(result.success).toBe(true);
  });

  it('拒绝引用互斥分支内节点的条件', () => {
    // 关键用例：图上连通，但 heavy 只在 case_1 分支里执行；从 else 分支到达 recheck 时
    // heavy 根本没跑过，运行时必定取到空值。这类错误在发布期可判定，就必须在发布期拦。
    const definition = conditionDefinition();
    const result = validateFlowDefinition({
      ...definition,
      nodes: [
        // 去掉 brief：它在下面的新边里没有入边，会变成第二个入口，unique-entry 提前返回，
        // 支配集根本不会被计算，用例就测不到 ref-dominates
        ...definition.nodes.filter((node) => node.id !== 'brief'),
        {
          id: 'heavy',
          type: 'agent',
          config: {
            modelPreset: 'agent-default',
            toolGroups: [],
            skills: [],
            maxToolIterations: 1,
          },
        },
        {
          id: 'recheck',
          type: 'condition',
          config: {
            cases: [
              {
                key: 'case_1',
                logic: 'and',
                conditions: [
                  {
                    ref: { $ref: ['heavy', 'text'] },
                    operator: 'notEmpty',
                  },
                ],
              },
            ],
          },
        },
        { id: 'tail', type: 'synthesize', config: {} },
      ],
      edges: [
        { from: 'plan', to: 'classify' },
        { from: 'classify', to: 'heavy', when: 'case_1' },
        { from: 'classify', to: 'recheck', when: 'else' },
        { from: 'heavy', to: 'recheck' },
        { from: 'recheck', to: 'answer', when: 'case_1' },
        { from: 'recheck', to: 'tail', when: 'else' },
      ],
    });

    expectValidationError(
      result,
      (error) =>
        error.rule === 'ref-dominates' && error.message.includes('heavy'),
    );
  });

  it('拒绝引用下游节点的条件', () => {
    const definition = conditionDefinition();
    const result = validateFlowDefinition({
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.id === 'classify'
          ? {
              ...node,
              config: {
                cases: [
                  {
                    key: 'case_1',
                    logic: 'and',
                    conditions: [
                      {
                        ref: { $ref: ['answer', 'text'] },
                        operator: 'notEmpty',
                      },
                    ],
                  },
                ],
              },
            }
          : node,
      ),
    });

    expectValidationError(result, (error) => error.rule === 'ref-dominates');
  });

  it('拒绝算子与被引输出类型不匹配', () => {
    // stepCount 是 number，startsWith 是字符串算子
    const result = validateFlowDefinition(
      conditionDefinition({ operator: 'startsWith', value: 'x' }),
    );

    expectValidationError(result, (error) => error.rule === 'ref-type-match');
  });

  it('拒绝引用未声明的输出字段', () => {
    const result = validateFlowDefinition(
      conditionDefinition({ ref: { $ref: ['plan', 'notDeclared'] } }),
    );

    expectValidationError(result, (error) => error.rule === 'ref-target');
  });

  it('拒绝该带比较值却没带的算子', () => {
    const result = validateFlowDefinition(
      conditionDefinition({ operator: 'gt', value: undefined }),
    );

    expectValidationError(
      result,
      (error) => error.rule === 'condition-value-required',
    );
  });

  it('拒绝只连出部分声明分支的节点', () => {
    const definition = conditionDefinition();
    const result = validateFlowDefinition({
      ...definition,
      // 去掉 else 出边：命中 else 时运行时无处可去，Flow 会静默停住
      edges: definition.edges.filter((edge) => edge.when !== 'else'),
    });

    expectValidationError(result, (error) => error.rule === 'branch-coverage');
  });
});

/**
 * 构造带计划审批和 PlanLoop 的合法 FlowDefinition 原始 JSON
 * @returns 返回仅用于验证器输入的结构化 JSON 对象
 * @description 以文档中的 Plan Execute 形状覆盖入口、终点、节点闭集与条件边校验。
 */
function validDefinition() {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
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
 * 构造一个带条件分支的合法 FlowDefinition 原始 JSON
 * @param overrides 覆盖 classify 节点里那条判定的字段
 * @returns 返回仅用于验证器输入的结构化 JSON 对象
 * @description plan -> classify 保证被引的 plan.stepCount 支配 classify；两条分支都连出，
 * 满足分支完备性。各用例只改这一条判定，便于把失败原因锁定到单一规则。
 */
function conditionDefinition(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow',
    name: '按计划规模分流',
    policy: {
      maxSteps: 5,
      maxModelCalls: 8,
      maxToolCalls: 12,
      maxDurationSeconds: 900,
    },
    nodes: [
      { id: 'plan', type: 'plan', config: { maxSteps: 5 } },
      {
        id: 'classify',
        type: 'condition',
        config: {
          cases: [
            {
              key: 'case_1',
              logic: 'and',
              conditions: [
                {
                  ref: { $ref: ['plan', 'stepCount'] },
                  operator: 'gt',
                  value: 3,
                  ...overrides,
                },
              ],
            },
          ],
        },
      },
      { id: 'answer', type: 'synthesize', config: {} },
      { id: 'brief', type: 'synthesize', config: {} },
    ],
    edges: [
      { from: 'plan', to: 'classify' },
      { from: 'classify', to: 'answer', when: 'case_1' },
      { from: 'classify', to: 'brief', when: 'else' },
    ],
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
