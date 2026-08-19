import { Test, type TestingModule } from '@nestjs/testing';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { CapabilityRegistry } from '../../ai/agent-loop/capability/capability.registry';
import { LlmModelRegistryService } from '../../llm/llm-model-registry.service';
import { FlowCompiler } from './flow-compiler.service';
import { FlowRuntimeValidator } from './flow-runtime-validator.service';

describe('FlowCompiler', () => {
  let compiler: FlowCompiler;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlowCompiler,
        FlowRuntimeValidator,
        {
          provide: CapabilityRegistry,
          useValue: {
            listToolGroups: () => ['image-gen'],
            getSkill: () => undefined,
            getTool: () => undefined,
            getToolsByGroup: (group: string) =>
              group === 'image-gen' ? [{ name: 'generateImage' }] : [],
            requiresApproval: (toolName: string) =>
              toolName === 'generateImage',
          },
        },
        {
          provide: LlmModelRegistryService,
          useValue: {
            listAvailableModels: () => [{ id: 'model-enabled' }],
          },
        },
      ],
    }).compile();

    compiler = module.get(FlowCompiler);
  });

  it('将锁定 Definition 编译为受限节点计划并从注册表计算审批工具', () => {
    const result = compiler.compile(definition(), {
      agentDefaultModelPreset: 'model-enabled',
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error('有效 Flow 不应编译失败');
    }
    expect(result.plan.entryNodeKey).toBe('answer');
    expect(result.plan.nodes).toEqual([
      expect.objectContaining({
        key: 'answer',
        type: 'agent',
        modelPreset: 'model-enabled',
        approvalToolNames: ['generateImage'],
        next: { default: 'finish' },
      }),
      expect.objectContaining({ key: 'finish', type: 'synthesize', next: {} }),
    ]);
  });

  it('在任务默认模型未锁定时拒绝编译 agent-default 节点', () => {
    const result = compiler.compile(definition(), {
      agentDefaultModelPreset: null,
    });

    expect(result).toEqual({
      success: false,
      errors: [
        expect.objectContaining({
          path: 'nodes.0.config.modelPreset',
          rule: 'agent-default-resolved',
        }),
      ],
    });
  });

  it('编译 PlanLoop 时沿用 Flow 步骤预算，而不是工具迭代上限', () => {
    const result = compiler.compile(planLoopDefinition(), {
      agentDefaultModelPreset: 'model-enabled',
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error('有效 PlanLoop Flow 不应编译失败');
    }
    const planLoop = result.plan.nodes.find((node) => node.key === 'execute');
    expect(planLoop?.type).toBe('plan-loop');
    if (!planLoop || planLoop.type !== 'plan-loop') {
      throw new Error('编译结果应包含 PlanLoop 节点');
    }
    expect(planLoop.planLoopPolicy.maxSteps).toBe(5);
  });
});

/**
 * 创建包含审批工具的线性 FlowDefinition
 * @returns 返回 Agent 后接汇总节点的有效定义
 * @description 用 image-gen 验证审批策略只从 CapabilityRegistry 计算，JSON 中没有可写入的降级字段。
 */
function definition(): FlowDefinition {
  return {
    schemaVersion: 1,
    kind: 'agent-flow',
    name: '编译测试',
    policy: {
      maxSteps: 1,
      maxModelCalls: 2,
      maxToolCalls: 1,
      maxDurationSeconds: 60,
    },
    nodes: [
      {
        id: 'answer',
        type: 'agent',
        config: {
          modelPreset: 'agent-default',
          toolGroups: ['image-gen'],
          skills: [],
          maxToolIterations: 1,
        },
      },
      { id: 'finish', type: 'synthesize', config: {} },
    ],
    edges: [{ from: 'answer', to: 'finish' }],
  };
}

/**
 * 创建带 PlanLoop 的有效 FlowDefinition
 * @returns 返回计划、执行和汇总串联的 Definition
 * @description executor.maxToolIterations 与 policy.maxSteps 故意设为不同值，防止编译器混淆两个预算维度。
 */
function planLoopDefinition(): FlowDefinition {
  return {
    schemaVersion: 1,
    kind: 'agent-flow',
    name: 'PlanLoop 编译测试',
    policy: {
      maxSteps: 5,
      maxModelCalls: 8,
      maxToolCalls: 8,
      maxDurationSeconds: 120,
    },
    nodes: [
      { id: 'plan', type: 'plan', config: { maxSteps: 5 } },
      {
        id: 'execute',
        type: 'plan-loop',
        config: {
          executor: {
            type: 'agent',
            modelPreset: 'agent-default',
            toolGroups: [],
            skills: [],
            maxToolIterations: 1,
          },
          stopPolicy: 'all-steps',
        },
      },
      { id: 'finish', type: 'synthesize', config: {} },
    ],
    edges: [
      { from: 'plan', to: 'execute' },
      { from: 'execute', to: 'finish' },
    ],
  };
}
