import { AgentFlowVersionStatus, StreamTaskStatus } from '@prisma/client';
import { AGENT_FLOW_SCHEMA_VERSION } from '@litter-bear/types/agent-flow';
import { ModelPresetReferenceService } from './model-preset-reference.service';

describe('ModelPresetReferenceService', () => {
  it('汇总 Agent 关系、全部模型节点和未终结任务快照', async () => {
    const prisma = {
      agent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'agent-1',
            name: '客服',
            defaultModelPreset: { presetId: 'model-agent-default' },
            allowedModelPresets: [
              { modelPreset: { presetId: 'model-agent-default' } },
              { modelPreset: { presetId: 'model-agent-optional' } },
            ],
          },
        ]),
      },
      agentFlowVersion: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'version-1',
            version: 3,
            status: AgentFlowVersionStatus.PUBLISHED,
            definition: modelFlowDefinition(),
            flow: { id: 'flow-1', name: '模型归属测试' },
          },
        ]),
      },
      streamTask: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'task-1',
            status: StreamTaskStatus.WAITING_HUMAN,
            resolvedAgentModelPresetId: 'model-agent-default',
          },
        ]),
      },
    };
    const service = new ModelPresetReferenceService(prisma as never);

    const references = await service.findByPresetIds([
      'model-agent-default',
      'model-agent-optional',
      'model-agent-node',
      'model-plan',
      'model-approval',
      'model-plan-loop',
      'model-synthesize',
    ]);

    expect(references.get('model-agent-default')).toMatchObject({
      agentCount: 1,
      flowCount: 0,
      taskCount: 1,
    });
    expect(references.get('model-agent-optional')).toMatchObject({
      agentCount: 1,
      flowCount: 0,
      taskCount: 0,
    });
    for (const presetId of [
      'model-agent-node',
      'model-plan',
      'model-approval',
      'model-plan-loop',
      'model-synthesize',
    ]) {
      expect(references.get(presetId)).toMatchObject({
        agentCount: 0,
        flowCount: 1,
        taskCount: 0,
      });
    }
  });
});

/**
 * 构造覆盖全部模型调用节点的有效 Flow
 * @returns 返回 agent、plan、模型审批、plan-loop 和 synthesize 串联的当前版本 Definition
 * @description 每类节点使用不同显式预设，确保引用扫描不会遗漏某一种配置位置。
 */
function modelFlowDefinition() {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow' as const,
    name: '模型归属测试',
    policy: {
      maxSteps: 3,
      maxModelCalls: 8,
      maxToolCalls: 0,
      maxDurationSeconds: 60,
    },
    nodes: [
      { id: 'start', type: 'start' as const, config: {} },
      {
        id: 'draft',
        type: 'agent' as const,
        config: {
          modelPreset: 'model-agent-node',
          toolGroups: [],
          skills: [],
          maxToolIterations: 1,
        },
      },
      {
        id: 'plan',
        type: 'plan' as const,
        config: { modelPreset: 'model-plan', maxSteps: 3 },
      },
      {
        id: 'review',
        type: 'approval' as const,
        config: {
          kind: 'plan-review' as const,
          policy: 'model' as const,
          modelPreset: 'model-approval',
          planRef: { $ref: ['plan', 'steps'] as [string, string] },
        },
      },
      {
        id: 'execute',
        type: 'plan-loop' as const,
        config: {
          executor: {
            type: 'agent' as const,
            modelPreset: 'model-plan-loop',
            toolGroups: [],
            skills: [],
            maxToolIterations: 1,
          },
          stopPolicy: 'all-steps' as const,
          planRef: { $ref: ['review', 'steps'] as [string, string] },
        },
      },
      {
        id: 'answer',
        type: 'synthesize' as const,
        config: {
          modelPreset: 'model-synthesize',
          observationsRef: {
            $ref: ['execute', 'observations'] as [string, string],
          },
        },
      },
      { id: 'end', type: 'end' as const, config: {} },
    ],
    edges: [
      { from: 'start', to: 'draft' },
      { from: 'draft', to: 'plan' },
      { from: 'plan', to: 'review' },
      { from: 'review', to: 'execute', when: 'approved' },
      { from: 'execute', to: 'answer' },
      { from: 'answer', to: 'end' },
    ],
  };
}
