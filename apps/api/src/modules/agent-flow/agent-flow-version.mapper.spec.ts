import { AgentFlowVersionStatus, type AgentFlowVersion } from '@prisma/client';
import {
  AGENT_FLOW_SCHEMA_VERSION,
  type FlowDefinition,
} from '@litter-bear/types/agent-flow';
import { toAgentFlowVersionResponse } from './agent-flow-version.mapper';

const validDefinition: FlowDefinition = {
  schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
  kind: 'agent-flow',
  name: 'Direct',
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
};

/**
 * 构造一条 AgentFlowVersion 记录
 * @param definition 该版本存储的 Definition JSON
 * @returns 返回可交给 mapper 的记录
 */
function versionRow(definition: unknown): AgentFlowVersion {
  return {
    id: 'version-1',
    flowId: 'flow-1',
    version: 1,
    status: AgentFlowVersionStatus.PUBLISHED,
    // definition 列是 Prisma Json，测试直接放入构造好的 JSON 值
    definition: definition as AgentFlowVersion['definition'],
    digest: 'a'.repeat(64),
    schemaVersion: 1,
    createdById: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    publishedAt: new Date(0),
    archivedAt: null,
  };
}

describe('toAgentFlowVersionResponse', () => {
  it('合法工件标记为兼容且不带错误明细', () => {
    const response = toAgentFlowVersionResponse(versionRow(validDefinition));

    expect(response.schemaCompatible).toBe(true);
    expect(response.schemaErrors).toBeUndefined();
    expect(response.definition).toEqual(validDefinition);
  });

  it('旧 schemaVersion 的存量工件不再让读取失败，而是标记不兼容', () => {
    // 回归用：原先这里调 requireValidDefinition 收敛 Json 类型，契约升到 2 之后
    // 一条 schemaVersion=1 的旧数据就让整个 Flow 列表返回 400，管理员连别的 Flow
    // 都看不到、删不掉；而且 GET 返回 400 语义本身就是错的。
    const legacy = { ...validDefinition, schemaVersion: 1 };

    const response = toAgentFlowVersionResponse(versionRow(legacy));

    expect(response.schemaCompatible).toBe(false);
    expect(response.schemaErrors).toEqual([
      expect.objectContaining({ path: 'schemaVersion', rule: 'schema' }),
    ]);
    // 原文照返：管理端要能看到、导出、重建它，不能被抹成空对象
    expect(response.definition).toEqual(legacy);
  });

  it('损坏成数组或标量时返回空对象并标记不兼容', () => {
    for (const broken of [[1, 2], 'not-an-object', null]) {
      const response = toAgentFlowVersionResponse(versionRow(broken));

      expect(response.schemaCompatible).toBe(false);
      expect(response.definition).toEqual({});
    }
  });
});
