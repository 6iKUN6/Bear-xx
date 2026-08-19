import { Injectable } from '@nestjs/common';
import type {
  FlowAgentNodeConfig,
  FlowDefinition,
  FlowEdgeWhen,
  FlowNode,
} from '@litter-bear/types/agent-flow';
import { CapabilityRegistry } from '../../ai/agent-loop/capability/capability.registry';
import type {
  CompiledAgentFlowNode,
  CompiledFlowNode,
  FlowCompilationResult,
  FlowTaskRuntimeContext,
} from './flow-runtime.types';
import { FlowRuntimeValidator } from './flow-runtime-validator.service';

/**
 * Flow 编译器
 * @description 将已锁定的 JSON Definition 转换为仅包含固定节点类型、模型、能力与边跳转的普通数据计划，不执行动态代码。
 */
@Injectable()
export class FlowCompiler {
  constructor(
    private readonly runtimeValidator: FlowRuntimeValidator,
    private readonly capabilityRegistry: CapabilityRegistry,
  ) {}

  /**
   * 编译一个已锁定版本的 FlowDefinition
   * @param definition 已完成结构校验且将绑定至 StreamTask 的 Definition
   * @param context 任务锁定的默认模型与用户级凭据上下文
   * @returns 返回可执行的受限计划，或运行时闭集校验错误
   * @description 编译前再次执行任务期校验；输出只保留节点数据和固定边，禁止从 JSON 反射类名、导入模块或执行脚本。
   */
  compile(
    definition: FlowDefinition,
    context: Omit<FlowTaskRuntimeContext, 'phase'>,
  ): FlowCompilationResult {
    const validation = this.runtimeValidator.validate(definition, {
      phase: 'task',
      ...context,
    });
    if (!validation.valid) {
      return { success: false, errors: validation.errors };
    }

    const nextByNode = this.buildNextByNode(definition);
    const entryNodeKey = this.findEntryNodeKey(definition);
    return {
      success: true,
      plan: {
        definition,
        entryNodeKey,
        nodes: definition.nodes.map((node) =>
          this.compileNode(
            node,
            nextByNode.get(node.id) ?? {},
            context,
            definition.policy.maxSteps,
          ),
        ),
      },
    };
  }

  /**
   * 构建每个节点的受限分支跳转表
   * @param definition 已通过结构校验的 FlowDefinition
   * @returns 返回节点 ID 到固定 branch->target 映射的只读映射
   * @description FlowDefinition 结构校验已保证分支唯一和端点存在，编译器仅将边转为运行时无需解析表达式的查表结构。
   */
  private buildNextByNode(
    definition: FlowDefinition,
  ): ReadonlyMap<string, Readonly<Record<string, string>>> {
    const nextByNode = new Map<string, Record<string, string>>();
    for (const edge of definition.edges) {
      const next = nextByNode.get(edge.from) ?? {};
      next[this.getBranchKey(edge.when)] = edge.to;
      nextByNode.set(edge.from, next);
    }
    return nextByNode;
  }

  /**
   * 获取边在编译计划中的分支键
   * @param when Definition 声明的可选 edge 分支
   * @returns 返回 runtime 固定使用的分支键
   * @description 默认边统一用 default，审批和条件节点保留其受限枚举，不解析任意表达式。
   */
  private getBranchKey(when: FlowEdgeWhen | undefined): string {
    return when ?? 'default';
  }

  /**
   * 查找 Flow 唯一入口节点
   * @param definition 已通过结构校验的 FlowDefinition
   * @returns 返回唯一入口节点 ID
   * @description 纯领域校验已经保证唯一入口；此处保留防御性异常，避免脏历史数据被编译为不可启动计划。
   */
  private findEntryNodeKey(definition: FlowDefinition): string {
    const incoming = new Set(definition.edges.map((edge) => edge.to));
    const entry = definition.nodes.find((node) => !incoming.has(node.id));
    if (!entry) {
      throw new Error('FlowDefinition 缺少入口节点，不能编译');
    }
    return entry.id;
  }

  /**
   * 编译一个固定类型节点
   * @param node 当前已校验节点
   * @param next 当前节点的固定跳转表
   * @param context 任务锁定的运行时上下文
   * @param maxSteps Flow 级别的计划步骤预算
   * @returns 返回无需反射或动态执行的编译节点
   * @description 节点类型是共享类型中的闭集；switch 穷尽处理确保新节点类型必须显式实现后才能进入运行时。
   */
  private compileNode(
    node: FlowNode,
    next: Readonly<Record<string, string>>,
    context: Omit<FlowTaskRuntimeContext, 'phase'>,
    maxSteps: number,
  ): CompiledFlowNode {
    switch (node.type) {
      case 'agent':
        return {
          key: node.id,
          type: 'agent',
          next,
          ...this.compileExecutor(node.config, context),
        };
      case 'plan':
        return {
          key: node.id,
          type: 'plan',
          next,
          maxSteps: node.config.maxSteps,
        };
      case 'plan-loop':
        return {
          key: node.id,
          type: 'plan-loop',
          next,
          planLoopPolicy: {
            stopPolicy: node.config.stopPolicy,
            planReview: 'disabled',
            maxSteps,
          },
          executor: this.compileExecutor(node.config.executor, context),
        };
      case 'approval':
        return { key: node.id, type: 'approval', next, kind: node.config.kind };
      case 'condition':
        return {
          key: node.id,
          type: 'condition',
          next,
          condition: node.config,
        };
      case 'synthesize':
        return { key: node.id, type: 'synthesize', next };
    }
  }

  /**
   * 编译 Agent 或 PlanLoop 内部 Agent 的能力配置
   * @param config 已通过运行时校验的执行器配置
   * @param context 任务锁定的默认模型与用户级凭据上下文
   * @returns 返回模型、能力和由注册表计算的审批工具集合
   * @description requiresApproval 永远由 CapabilityRegistry 推导，Flow JSON 没有降低工具风险等级的入口。
   */
  private compileExecutor(
    config: FlowAgentNodeConfig,
    context: Omit<FlowTaskRuntimeContext, 'phase'>,
  ): Omit<CompiledAgentFlowNode, 'key' | 'type' | 'next'> {
    const toolNames = new Set<string>();
    for (const group of config.toolGroups) {
      for (const tool of this.capabilityRegistry.getToolsByGroup(group)) {
        toolNames.add(tool.name);
      }
    }
    for (const skillName of config.skills) {
      const skill = this.capabilityRegistry.getSkill(skillName);
      for (const toolName of skill?.toolNames ?? []) {
        toolNames.add(toolName);
      }
    }
    const modelPreset =
      config.modelPreset === 'agent-default' || !config.modelPreset
        ? context.agentDefaultModelPreset
        : config.modelPreset;
    if (!modelPreset) {
      throw new Error('agent-default 未在任务上下文中解析');
    }
    return {
      modelPreset,
      toolGroups: [...config.toolGroups],
      skills: [...config.skills],
      maxToolIterations: config.maxToolIterations,
      approvalToolNames: [...toolNames].filter((toolName) =>
        this.capabilityRegistry.requiresApproval(toolName),
      ),
    };
  }
}
