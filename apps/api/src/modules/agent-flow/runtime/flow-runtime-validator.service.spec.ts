import { Test, type TestingModule } from '@nestjs/testing';
import {
  AGENT_FLOW_SCHEMA_VERSION,
  type FlowDefinition,
} from '@litter-bear/types/agent-flow';
import { CapabilityRegistry } from '../../ai/agent-loop/capability/capability.registry';
import { LlmModelRegistryService } from '../../llm/llm-model-registry.service';
import { FlowRuntimeValidator } from './flow-runtime-validator.service';

describe('FlowRuntimeValidator', () => {
  let validator: FlowRuntimeValidator;
  let capability: string;

  beforeEach(async () => {
    capability = 'tools';
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlowRuntimeValidator,
        {
          provide: CapabilityRegistry,
          useValue: createCapabilityRegistry(),
        },
        {
          provide: LlmModelRegistryService,
          useValue: {
            listAvailableModels: () => [{ id: 'model-enabled' }],
            // 能力档位来自真实探测；默认给通过工具往返的档位
            getCapability: () => capability,
            normalizePresetReasoning: (_presetId: string, selection: unknown) =>
              selection,
          },
        },
      ],
    }).compile();

    validator = module.get(FlowRuntimeValidator);
  });

  it('在发布前拒绝未注册的模型、工具组和技能', () => {
    const result = validator.validate({
      ...baseDefinition(),
      nodes: [
        {
          id: 'answer',
          type: 'agent',
          config: {
            modelPreset: 'missing-model',
            toolGroups: ['missing-group'],
            skills: ['missing-skill'],
            maxToolIterations: 1,
          },
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.path === 'nodes.0.config.modelPreset' &&
          error.rule === 'model-preset-exists',
      ),
    ).toBe(true);
    expect(
      result.errors.some(
        (error) =>
          error.path === 'nodes.0.config.toolGroups.0' &&
          error.rule === 'tool-group-exists',
      ),
    ).toBe(true);
    expect(
      result.errors.some(
        (error) =>
          error.path === 'nodes.0.config.skills.0' &&
          error.rule === 'skill-exists',
      ),
    ).toBe(true);
  });

  it('发布期拒绝 agent-default，任务锁定期允许内置 direct Flow 解析它', () => {
    const base = baseDefinition();
    const definition: FlowDefinition = {
      ...base,
      nodes: base.nodes.map((node) =>
        node.type === 'agent'
          ? {
              ...node,
              config: { ...node.config, modelPreset: 'agent-default' },
            }
          : node,
      ),
    };

    expect(validator.validate(definition)).toEqual({
      valid: false,
      errors: [
        expect.objectContaining({
          path: 'nodes.0.config.modelPreset',
          rule: 'custom-flow-concrete-model',
        }),
      ],
    });
    expect(
      validator.validate(definition, {
        phase: 'task',
        agentDefaultModelPreset: null,
      }),
    ).toEqual({
      valid: false,
      errors: [
        expect.objectContaining({
          path: 'nodes.0.config.modelPreset',
          rule: 'agent-default-resolved',
        }),
      ],
    });
    expect(
      validator.validate(definition, {
        phase: 'task',
        agentDefaultModelPreset: 'model-enabled',
      }),
    ).toEqual({ valid: true, errors: [] });
    expect(
      validator.validate(definition, {
        phase: 'task',
        agentDefaultModelPreset: 'missing-model',
      }),
    ).toEqual({
      valid: false,
      errors: [
        expect.objectContaining({
          path: 'nodes.0.config.modelPreset',
          rule: 'model-preset-exists',
        }),
      ],
    });
  });

  it('拒绝把未通过工具往返探测的模型配到带工具的节点上', () => {
    // 只过 L1 连通性的预设在第一次工具回填时才会炸，必须在发布期拦住
    capability = 'basic';

    const result = validator.validate(withToolGroup());

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ rule: 'model-preset-tool-capability' }),
    );
  });

  it('尚未探测的模型同样不能用于带工具的节点', () => {
    capability = 'unverified';

    const result = validator.validate(withToolGroup());

    expect(result.errors[0].message).toContain('尚未通过连通性探测');
  });

  it('未配工具的节点不受能力档位限制', () => {
    // basic 档位仍可用于 synthesize 这类无工具场景，不该一刀切禁用
    capability = 'basic';

    expect(validator.validate(baseDefinition()).valid).toBe(true);
  });
});

/**
 * 构造一个带工具组的 Agent 节点定义
 * @returns 返回引用已注册工具组的定义
 */
function withToolGroup(): FlowDefinition {
  return {
    ...baseDefinition(),
    nodes: [
      {
        id: 'answer',
        type: 'agent',
        config: {
          modelPreset: 'model-enabled',
          toolGroups: ['weather'],
          skills: [],
          maxToolIterations: 1,
        },
      },
    ],
  };
}

/**
 * 创建最小的有效 FlowDefinition
 * @returns 返回继承任务默认模型的单 Agent 定义
 * @description 测试仅覆盖运行时能力闭集，图结构已由纯领域校验器单独覆盖。
 */
function baseDefinition(): FlowDefinition {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow',
    name: '运行时校验',
    policy: {
      maxSteps: 1,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxDurationSeconds: 60,
    },
    nodes: [
      {
        id: 'answer',
        type: 'agent',
        config: {
          modelPreset: 'model-enabled',
          toolGroups: [],
          skills: [],
          maxToolIterations: 1,
        },
      },
    ],
    edges: [],
  };
}

/**
 * 创建能力注册表替身
 * @returns 返回满足运行时校验最小读取接口的对象
 * @description 使用固定闭集避免测试依赖图片服务、配置或外部 MCP 连接。
 */
function createCapabilityRegistry() {
  return {
    listToolGroups: () => ['default', 'image-gen', 'mcd-order'],
    getSkill: (name: string) =>
      name === 'research'
        ? { name: 'research', toolNames: ['webSearch'] }
        : undefined,
    getTool: (name: string) =>
      name === 'webSearch' ? { name: 'webSearch' } : undefined,
  };
}
