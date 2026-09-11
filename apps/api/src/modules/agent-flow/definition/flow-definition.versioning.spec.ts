import { AGENT_FLOW_SCHEMA_VERSION } from '@litter-bear/types/agent-flow';
import { calculateFlowDefinitionDigest } from './flow-definition.digest';
import {
  inspectFlowDefinition,
  normalizeFlowDefinition,
} from './flow-definition.versioning';

describe('FlowDefinitionVersioning', () => {
  it('无 Loop 的合法 v9 只升级版本并保留原布局', () => {
    const legacy = directV9();

    const inspection = inspectFlowDefinition(legacy);

    expect(inspection.status).toBe('upgradeable');
    expect(inspection.definition).toEqual({
      ...legacy,
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    });
    expect(inspection.report).toEqual({
      fromVersion: 9,
      toVersion: AGENT_FLOW_SCHEMA_VERSION,
      loopAssignments: [],
      relativeLayoutNodeIds: [],
    });
    const normalized = normalizeFlowDefinition(legacy);
    expect(normalized.success).toBe(true);
    if (!normalized.success) return;
    expect(normalized.sourceDigest).toBe(calculateFlowDefinitionDigest(legacy));
    expect(normalized.sourceDigest).not.toBe(
      calculateFlowDefinitionDigest(inspection.definition!),
    );
  });

  it('v9 Loop 确定性补齐归属并把体内坐标转成相对坐标', () => {
    const legacy = loopV9();
    const sourceSnapshot = structuredClone(legacy);

    const first = inspectFlowDefinition(legacy);
    const second = inspectFlowDefinition(legacy);

    expect(first).toEqual(second);
    expect(legacy).toEqual(sourceSnapshot);
    expect(first.status).toBe('upgradeable');
    expect(first.definition?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'generate', loopId: 'quality_loop' }),
        expect.objectContaining({ id: 'judge', loopId: 'quality_loop' }),
      ]),
    );
    expect(first.definition?.layout?.nodes).toMatchObject({
      quality_loop: {
        x: 376,
        y: 108,
        width: 480,
        height: 220,
        collapsed: false,
      },
      generate: { x: 24, y: 72 },
      judge: { x: 264, y: 72 },
    });
    expect(first.report).toEqual({
      fromVersion: 9,
      toVersion: AGENT_FLOW_SCHEMA_VERSION,
      loopAssignments: [
        { nodeId: 'generate', loopId: 'quality_loop' },
        { nodeId: 'judge', loopId: 'quality_loop' },
      ],
      relativeLayoutNodeIds: ['generate', 'judge'],
    });
  });

  it('当前版本结构可识别，但运行时仍拒绝未闭合拓扑', () => {
    const draft = {
      ...directV9(),
      schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
      edges: [],
    };

    expect(inspectFlowDefinition(draft).status).toBe('current');
    const normalized = normalizeFlowDefinition(draft);
    expect(normalized.success).toBe(false);
    if (!normalized.success) {
      expect(normalized.inspection.errors.length).toBeGreaterThan(0);
    }
  });

  it('区分不支持版本与已损坏 v9', () => {
    expect(
      inspectFlowDefinition({ ...directV9(), schemaVersion: 8 }).status,
    ).toBe('unsupported');
    expect(inspectFlowDefinition({ ...directV9(), nodes: [] }).status).toBe(
      'invalid',
    );
  });
});

/** 构造无 Loop 的合法 v9 工件。 */
function directV9() {
  return {
    schemaVersion: 9,
    kind: 'agent-flow',
    name: '直接回复',
    policy: {
      maxSteps: 1,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxDurationSeconds: 60,
    },
    nodes: [
      { id: 'start', type: 'start', config: {} },
      {
        id: 'answer',
        type: 'agent',
        config: { toolGroups: [], skills: [], maxToolIterations: 1 },
      },
      { id: 'end', type: 'end', config: {} },
    ],
    edges: [
      { from: 'start', to: 'answer' },
      { from: 'answer', to: 'end' },
    ],
    layout: {
      nodes: {
        start: { x: 0, y: 10 },
        answer: { x: 240, y: 10 },
        end: { x: 480, y: 10 },
      },
    },
  };
}

/** 构造带双节点循环体和绝对坐标的合法 v9 工件。 */
function loopV9() {
  return {
    schemaVersion: 9,
    kind: 'agent-flow',
    name: '质量循环',
    policy: {
      maxSteps: 8,
      maxModelCalls: 12,
      maxToolCalls: 0,
      maxDurationSeconds: 600,
    },
    nodes: [
      { id: 'start', type: 'start', config: {} },
      {
        id: 'quality_loop',
        type: 'loop',
        config: { maxIterations: 3, continueWhen: [] },
      },
      {
        id: 'generate',
        type: 'agent',
        config: { toolGroups: [], skills: [], maxToolIterations: 1 },
      },
      {
        id: 'judge',
        type: 'agent',
        config: { toolGroups: [], skills: [], maxToolIterations: 1 },
      },
      { id: 'answer', type: 'synthesize', config: {} },
      { id: 'end', type: 'end', config: {} },
    ],
    edges: [
      { from: 'start', to: 'quality_loop' },
      { from: 'quality_loop', to: 'generate', when: 'again' },
      { from: 'generate', to: 'judge' },
      { from: 'judge', to: 'quality_loop' },
      { from: 'quality_loop', to: 'answer', when: 'done' },
      { from: 'answer', to: 'end' },
    ],
    layout: {
      nodes: {
        start: { x: 0, y: 180 },
        quality_loop: { x: 240, y: 180 },
        generate: { x: 400, y: 180 },
        judge: { x: 640, y: 180 },
        answer: { x: 880, y: 180 },
        end: { x: 1120, y: 180 },
      },
    },
  };
}
