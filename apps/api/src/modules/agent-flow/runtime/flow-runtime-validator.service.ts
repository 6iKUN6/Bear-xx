import { Injectable } from '@nestjs/common';
import type { FlowDefinition, FlowNode } from '@litter-bear/types/agent-flow';
import {
  CapabilityRegistry,
  MCDONALDS_ORDER_TOOL_GROUP,
} from '../../ai/agent-loop/capability/capability.registry';
import { LlmModelRegistryService } from '../../llm/llm-model-registry.service';
import type {
  FlowRuntimeValidationContext,
  FlowRuntimeValidationError,
  FlowRuntimeValidationResult,
} from './flow-runtime.types';

/**
 * Flow 运行时能力校验器
 * @description 在纯 JSON 结构校验之后，按当前模型与能力注册表闭集校验模型、工具组、技能及用户级凭据前置条件。
 */
@Injectable()
export class FlowRuntimeValidator {
  constructor(
    private readonly capabilityRegistry: CapabilityRegistry,
    private readonly modelRegistry: LlmModelRegistryService,
  ) {}

  /**
   * 校验 FlowDefinition 引用的运行时能力
   * @param definition 已通过纯结构校验的 FlowDefinition
   * @param context 发布期或任务锁定期的校验上下文，缺省为发布期
   * @returns 返回是否可运行及全部可展示错误
   * @description 发布期只验证静态能力闭集；任务锁定期还必须解析 agent-default 和用户级 mcd-order 凭据，绝不静默移除能力。
   */
  validate(
    definition: FlowDefinition,
    context: FlowRuntimeValidationContext = { phase: 'publish' },
  ): FlowRuntimeValidationResult {
    const errors: FlowRuntimeValidationError[] = [];
    const availableModels = new Set(
      this.modelRegistry.listAvailableModels().map((model) => model.id),
    );
    const toolGroups = new Set(this.capabilityRegistry.listToolGroups());

    definition.nodes.forEach((node, nodeIndex) => {
      this.validateNode(
        node,
        nodeIndex,
        context,
        availableModels,
        toolGroups,
        errors,
      );
    });

    return errors.length === 0
      ? { valid: true, errors: [] }
      : { valid: false, errors };
  }

  /**
   * 校验单个节点的能力引用
   * @param node 当前 Flow 节点
   * @param nodeIndex 节点在 Definition 中的位置
   * @param context 发布期或任务期上下文
   * @param availableModels 当前可用模型预设集合
   * @param toolGroups 当前可用工具组集合
   * @param errors 用于收集全部错误的数组
   * @returns 无返回值
   * @description 只有 agent 与 plan-loop.executor 可以引用模型、工具组与技能，其余节点没有可配置能力入口。
   */
  private validateNode(
    node: FlowNode,
    nodeIndex: number,
    context: FlowRuntimeValidationContext,
    availableModels: ReadonlySet<string>,
    toolGroups: ReadonlySet<string>,
    errors: FlowRuntimeValidationError[],
  ): void {
    if (node.type === 'agent') {
      this.validateExecutor(
        node.config,
        `nodes.${nodeIndex}.config`,
        context,
        availableModels,
        toolGroups,
        errors,
      );
      return;
    }
    if (node.type === 'plan-loop') {
      this.validateExecutor(
        node.config.executor,
        `nodes.${nodeIndex}.config.executor`,
        context,
        availableModels,
        toolGroups,
        errors,
      );
      return;
    }
    if (node.type === 'plan') {
      this.validateModelPreset(
        node.config.modelPreset,
        node.config.reasoning,
        `nodes.${nodeIndex}.config.modelPreset`,
        context,
        availableModels,
        errors,
      );
      return;
    }
    if (node.type === 'approval' && node.config.policy === 'model') {
      this.validateModelPreset(
        node.config.modelPreset,
        node.config.reasoning,
        `nodes.${nodeIndex}.config.modelPreset`,
        context,
        availableModels,
        errors,
      );
      return;
    }
    if (node.type === 'synthesize') {
      // synthesize 没有工具与技能，只需要校验模型；走同一条路径以保证
      // agent-default 的解析与报错口径一致
      this.validateExecutor(
        { ...node.config, toolGroups: [], skills: [] },
        `nodes.${nodeIndex}.config`,
        context,
        availableModels,
        toolGroups,
        errors,
      );
      return;
    }
    if (node.type === 'structured-output') {
      this.validateModelPreset(
        node.config.modelPreset,
        node.config.reasoning,
        `nodes.${nodeIndex}.config.modelPreset`,
        context,
        availableModels,
        errors,
      );
      return;
    }
    if (node.type === 'evaluate') {
      this.validateModelPreset(
        node.config.modelPreset,
        node.config.reasoning,
        `nodes.${nodeIndex}.config.modelPreset`,
        context,
        availableModels,
        errors,
      );
    }
  }

  /**
   * 校验 Agent 执行器的模型、工具组和技能
   * @param executor 节点中的受限执行器配置
   * @param path 配置在 Definition 中的字段路径
   * @param context 发布期或任务期上下文
   * @param availableModels 当前可用模型预设集合
   * @param toolGroups 当前可用工具组集合
   * @param errors 用于收集全部错误的数组
   * @returns 无返回值
   * @description agent-default 只能在任务创建时解析为锁定模型；mcd-order 只能在任务锁定了凭据后启动。
   */
  private validateExecutor(
    executor: {
      modelPreset?: string;
      reasoning?: import('@litter-bear/types').ReasoningSelection;
      toolGroups: readonly string[];
      skills: readonly string[];
    },
    path: string,
    context: FlowRuntimeValidationContext,
    availableModels: ReadonlySet<string>,
    toolGroups: ReadonlySet<string>,
    errors: FlowRuntimeValidationError[],
  ): void {
    const modelPreset = executor.modelPreset ?? 'agent-default';
    this.validateModelPreset(
      modelPreset,
      executor.reasoning,
      `${path}.modelPreset`,
      context,
      availableModels,
      errors,
    );

    // 配了工具却用一个没通过工具往返探测的模型，运行时才会炸在第一次工具回填上；
    // 这里提前拦住。能力档位来自真实探测，不是配置声明。
    if (executor.toolGroups.length > 0) {
      const effectivePreset =
        modelPreset === 'agent-default'
          ? context.phase === 'task'
            ? context.agentDefaultModelPreset
            : undefined
          : modelPreset;
      const capability = effectivePreset
        ? this.modelRegistry.getCapability(effectivePreset)
        : undefined;
      if (capability && capability !== 'tools') {
        errors.push({
          path: `${path}.modelPreset`,
          rule: 'model-preset-tool-capability',
          message:
            capability === 'unverified'
              ? `模型预设「${effectivePreset}」尚未通过连通性探测，不能用于带工具的节点，请先在后台测试连接`
              : `模型预设「${effectivePreset}」未通过工具往返探测（当前档位：${capability}），不能用于带工具的节点`,
        });
      }
    }

    executor.toolGroups.forEach((group, index) => {
      if (!toolGroups.has(group)) {
        errors.push({
          path: `${path}.toolGroups.${index}`,
          rule: 'tool-group-exists',
          message: `工具组「${group}」不存在`,
        });
        return;
      }
      if (
        context.phase === 'task' &&
        group === MCDONALDS_ORDER_TOOL_GROUP &&
        !context.mcdonaldsCredentialId
      ) {
        errors.push({
          path: `${path}.toolGroups.${index}`,
          rule: 'user-capability-credential',
          message: '点餐工具组需要任务锁定的用户凭据',
        });
      }
    });

    executor.skills.forEach((skillName, index) => {
      const skill = this.capabilityRegistry.getSkill(skillName);
      if (!skill) {
        errors.push({
          path: `${path}.skills.${index}`,
          rule: 'skill-exists',
          message: `技能「${skillName}」不存在`,
        });
        return;
      }
      for (const toolName of skill.toolNames ?? []) {
        if (!this.capabilityRegistry.getTool(toolName)) {
          errors.push({
            path: `${path}.skills.${index}`,
            rule: 'skill-tool-exists',
            message: `技能「${skillName}」引用了未注册工具「${toolName}」`,
          });
        }
      }
    });
  }

  /**
   * 校验节点声明的模型预设
   * @param declaredModelPreset 节点声明的模型；缺省等同于 agent-default
   * @param path 模型字段在 Definition 中的路径
   * @param context 发布期或任务期上下文
   * @param availableModels 当前可用模型预设集合
   * @param errors 用于收集全部错误的数组
   * @returns 无返回值
   * @description 发布期允许 agent-default 占位；任务期必须已锁定为当前仍可用的具体预设。
   * 显式预设在两个阶段都必须存在且启用。
   */
  private validateModelPreset(
    declaredModelPreset: string | undefined,
    reasoning: import('@litter-bear/types').ReasoningSelection | undefined,
    path: string,
    context: FlowRuntimeValidationContext,
    availableModels: ReadonlySet<string>,
    errors: FlowRuntimeValidationError[],
  ): void {
    const modelPreset = declaredModelPreset ?? 'agent-default';
    if (modelPreset === 'agent-default') {
      if (context.phase !== 'task') {
        errors.push({
          path,
          rule: 'custom-flow-concrete-model',
          message:
            '自定义 Flow 的模型节点必须选择具体模型预设，不能使用 agent-default',
        });
        return;
      }
      if (!context.agentDefaultModelPreset) {
        errors.push({
          path,
          rule: 'agent-default-resolved',
          message: '任务未锁定 Agent 默认模型，不能执行 agent-default',
        });
      } else if (!availableModels.has(context.agentDefaultModelPreset)) {
        errors.push({
          path,
          rule: 'model-preset-exists',
          message: `任务锁定的默认模型「${context.agentDefaultModelPreset}」不可用`,
        });
      } else {
        this.validateReasoning(
          context.agentDefaultModelPreset,
          context.agentDefaultReasoning,
          path.replace(/\.modelPreset$/, '.reasoning'),
          errors,
        );
      }
      return;
    }
    if (!availableModels.has(modelPreset)) {
      errors.push({
        path,
        rule: 'model-preset-exists',
        message: `模型预设「${modelPreset}」不存在或已禁用`,
      });
      return;
    }
    this.validateReasoning(
      modelPreset,
      reasoning,
      path.replace(/\.modelPreset$/, '.reasoning'),
      errors,
    );
  }

  /** 将目录异常收敛为可定位到节点字段的发布/任务校验错误。 */
  private validateReasoning(
    modelPreset: string,
    reasoning: import('@litter-bear/types').ReasoningSelection | undefined,
    path: string,
    errors: FlowRuntimeValidationError[],
  ): void {
    try {
      this.modelRegistry.normalizePresetReasoning(modelPreset, reasoning, {
        requireExplicit: true,
        applyDefault: false,
      });
    } catch (error) {
      errors.push({
        path,
        rule: 'model-reasoning-compatible',
        message:
          error instanceof Error ? error.message : '模型思考参数不受支持',
      });
    }
  }
}
