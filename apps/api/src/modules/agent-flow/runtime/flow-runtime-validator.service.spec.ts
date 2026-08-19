import { Test, type TestingModule } from '@nestjs/testing';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';
import { CapabilityRegistry } from '../../ai/agent-loop/capability/capability.registry';
import { LlmModelRegistryService } from '../../llm/llm-model-registry.service';
import { FlowRuntimeValidator } from './flow-runtime-validator.service';

describe('FlowRuntimeValidator', () => {
  let validator: FlowRuntimeValidator;

  beforeEach(async () => {
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

  it('发布期允许 agent-default，任务锁定期要求它解析为可用模型', () => {
    const definition = baseDefinition();

    expect(validator.validate(definition)).toEqual({ valid: true, errors: [] });
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
});

/**
 * 创建最小的有效 FlowDefinition
 * @returns 返回继承任务默认模型的单 Agent 定义
 * @description 测试仅覆盖运行时能力闭集，图结构已由纯领域校验器单独覆盖。
 */
function baseDefinition(): FlowDefinition {
  return {
    schemaVersion: 1,
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
          modelPreset: 'agent-default',
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
