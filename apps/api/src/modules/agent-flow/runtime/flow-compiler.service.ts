import { Injectable } from '@nestjs/common';
import type {
  FlowAgentNodeConfig,
  FlowDefinition,
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

    const entryNodeKey = this.findEntryNodeKey(definition);
    return {
      success: true,
      plan: {
        definition,
        entryNodeKey,
        nodes: definition.nodes.map((node) =>
          this.compileNode(node, context, definition.policy.maxSteps),
        ),
      },
    };
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
   * @param context 任务锁定的运行时上下文
   * @param maxSteps Flow 级别的计划步骤预算
   * @returns 返回无需反射或动态执行的编译节点
   * @description 节点类型是共享类型中的闭集；switch 穷尽处理确保新节点类型必须显式实现后才能进入运行时。
   */
  private compileNode(
    node: FlowNode,
    context: Omit<FlowTaskRuntimeContext, 'phase'>,
    maxSteps: number,
  ): CompiledFlowNode {
    switch (node.type) {
      case 'start':
        return { key: node.id, ...alias(node), type: 'start' };
      case 'end':
        return { key: node.id, ...alias(node), type: 'end' };
      case 'agent':
        return {
          key: node.id,
          ...alias(node),
          type: 'agent',
          ...this.compileExecutor(node.config, context),
        };
      case 'plan':
        return {
          key: node.id,
          ...alias(node),
          type: 'plan',
          modelPreset: this.resolveModelPreset(
            node.config.modelPreset,
            context,
          ),
          reasoning: this.resolveReasoning(
            node.config.modelPreset,
            node.config.reasoning,
            context,
          ),
          maxSteps: node.config.maxSteps,
        };
      case 'plan-loop':
        return {
          key: node.id,
          ...alias(node),
          type: 'plan-loop',
          planRef: node.config.planRef,
          planLoopPolicy: {
            stopPolicy: node.config.stopPolicy,
            planReview: 'disabled',
            maxSteps,
          },
          executor: this.compileExecutor(node.config.executor, context),
        };
      case 'approval':
        return {
          key: node.id,
          ...alias(node),
          type: 'approval',
          kind: node.config.kind,
          policy: node.config.policy,
          ...(node.config.policy === 'model'
            ? {
                modelPreset: this.resolveModelPreset(
                  node.config.modelPreset,
                  context,
                ),
                reasoning: this.resolveReasoning(
                  node.config.modelPreset,
                  node.config.reasoning,
                  context,
                ),
              }
            : {}),
          planRef: node.config.planRef,
        };
      case 'synthesize':
        return {
          key: node.id,
          ...alias(node),
          type: 'synthesize',
          ...(node.config.observationsRef
            ? { observationsRef: node.config.observationsRef }
            : {}),
          modelPreset: this.resolveModelPreset(
            node.config.modelPreset,
            context,
          ),
          reasoning: this.resolveReasoning(
            node.config.modelPreset,
            node.config.reasoning,
            context,
          ),
        };
      case 'join':
        return {
          key: node.id,
          ...alias(node),
          type: 'join',
          waitFor: node.config.waitFor,
          joinPolicy: node.config.policy,
        };
      case 'condition':
        return {
          key: node.id,
          ...alias(node),
          type: 'condition',
          cases: node.config.cases,
        };
      case 'loop':
        return {
          key: node.id,
          ...alias(node),
          type: 'loop',
          maxIterations: node.config.maxIterations,
          continueWhen: node.config.continueWhen,
        };
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
  ): Omit<CompiledAgentFlowNode, 'key' | 'type'> {
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
    return {
      modelPreset: this.resolveModelPreset(config.modelPreset, context),
      reasoning: this.resolveReasoning(
        config.modelPreset,
        config.reasoning,
        context,
      ),
      toolGroups: [...config.toolGroups],
      skills: [...config.skills],
      maxToolIterations: config.maxToolIterations,
      approvalToolNames: [...toolNames].filter((toolName) =>
        this.capabilityRegistry.requiresApproval(toolName),
      ),
    };
  }

  /**
   * 把节点声明的模型解析成具体预设
   * @param declared 节点上声明的预设；缺省或 agent-default 即跟随智能体默认
   * @param context 任务锁定的运行时上下文
   * @returns 返回具体模型预设标识
   * @description 所有会调用模型的节点共用：缺省模型都表示 agent-default，解析口径必须一致。
   * 任务期校验已先按节点判过一遍，这里的抛错只是防御性兜底。
   */
  private resolveModelPreset(
    declared: string | undefined,
    context: Omit<FlowTaskRuntimeContext, 'phase'>,
  ): string {
    const resolved =
      declared === 'agent-default' || !declared
        ? context.agentDefaultModelPreset
        : declared;
    if (!resolved) {
      throw new Error('agent-default 未在任务上下文中解析');
    }
    return resolved;
  }

  /** agent-default 继承任务快照，其余节点使用已发布 Definition 中的思考选择。 */
  private resolveReasoning(
    declaredModel: string | undefined,
    declaredReasoning:
      import('@litter-bear/types').ReasoningSelection | undefined,
    context: Omit<FlowTaskRuntimeContext, 'phase'>,
  ): import('@litter-bear/types').ReasoningSelection | undefined {
    return declaredModel === 'agent-default' || !declaredModel
      ? context.agentDefaultReasoning
      : declaredReasoning;
  }
}

/**
 * 取出节点别名的可展开片段
 * @param node 当前已校验节点
 * @returns 有别名时返回 `{ name }`，否则返回空对象
 * @description 用可展开片段而不是 `name: node.name`：后者会在没有别名时写入 `undefined`，
 * 让编译结果多出一个恒为空的键。别名一路带到运行时，是为了让 trace 与 SSE 的节点标题显示
 * 管理员起的名字而不是通用类型标题。
 */
function alias(node: FlowNode): { name?: string } {
  return node.name ? { name: node.name } : {};
}
