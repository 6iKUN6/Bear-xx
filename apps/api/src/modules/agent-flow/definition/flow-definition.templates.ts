import {
  AGENT_FLOW_SCHEMA_VERSION,
  type FlowDefinition,
  type FlowDefinitionPreset,
} from '@litter-bear/types/agent-flow';

const DEFAULT_POLICY = {
  maxSteps: 6,
  maxModelCalls: 12,
  maxToolCalls: 16,
  maxDurationSeconds: 900,
} as const;

/**
 * 生成内置 AgentFlow 预设 Definition
 * @param preset 当前支持的预设名称
 * @returns 返回可通过同一校验器的独立 FlowDefinition
 * @description 预设只表达结构与安全预算；`agent-default` 在运行时解析为任务锁定的 Agent 默认模型，不把部署环境模型写死进模板。
 */
export function createFlowDefinitionPreset(
  preset: FlowDefinitionPreset,
): FlowDefinition {
  switch (preset) {
    case 'blank':
      return blankPreset();
    case 'direct':
      return directPreset();
    case 'react':
      return reactPreset();
    case 'plan_execute':
      return planExecutePreset();
    case 'hybrid':
      return hybridPreset();
  }
}

/**
 * 生成空白预设
 * @returns 返回只含 start 节点的最小合法 Flow
 * @description 「只有 start」是结构合法的：唯一入口、且它本身就是可达终点。作为画布起点，
 * 用户从这里开始加节点。**它本身跑起来不产出任何回复**——描述里写明这一点，避免有人直接
 * 发布后拿到空回答还以为是坏了。
 */
function blankPreset(): FlowDefinition {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow',
    name: '空白流程',
    description: '只有起始节点；加上节点并连线后才会产出回复',
    policy: DEFAULT_POLICY,
    nodes: [{ id: 'start', type: 'start', config: {} }],
    edges: [],
  };
}

/**
 * 生成 Direct 预设
 * @returns 返回不装配工具的单 Agent Flow
 * @description 对应现有 DirectAnswerGraph，只有一个同时作为入口和终点的 Agent 节点。
 */
function directPreset(): FlowDefinition {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow',
    name: 'Direct',
    description: '直接生成回复',
    policy: { ...DEFAULT_POLICY, maxSteps: 1, maxToolCalls: 0 },
    nodes: [
      { id: 'start', type: 'start', config: {} },
      {
        id: 'answer',
        type: 'agent',
        config: agentConfig([]),
      },
    ],
    edges: [{ from: 'start', to: 'answer' }],
  };
}

/**
 * 生成 ReAct 预设
 * @returns 返回允许默认工具组的单 Agent Flow
 * @description 对应现有 CommonReactGraph；工具调用和工具审批仍封装在 agent 节点内部。
 */
function reactPreset(): FlowDefinition {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow',
    name: 'ReAct',
    description: '按需调用已授权工具并生成回复',
    policy: DEFAULT_POLICY,
    nodes: [
      { id: 'start', type: 'start', config: {} },
      {
        id: 'answer',
        type: 'agent',
        config: agentConfig(['default']),
      },
    ],
    edges: [{ from: 'start', to: 'answer' }],
  };
}

/**
 * 生成 Plan Execute 预设
 * @returns 返回计划、计划审批、受控 PlanLoop 与汇总组成的 Flow
 * @description 对应现有 PlanExecuteGraph；拒绝并重规划属于 approval 节点内部状态，不以图上通用回边表达。
 */
function planExecutePreset(): FlowDefinition {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow',
    name: 'Plan Execute',
    description: '先确认计划，再逐步执行并汇总',
    policy: DEFAULT_POLICY,
    nodes: [
      { id: 'start', type: 'start', config: {} },
      { id: 'plan', type: 'plan', config: { maxSteps: 6 } },
      {
        id: 'review',
        type: 'approval',
        config: {
          kind: 'plan-review',
          policy: 'always',
          planRef: { $ref: ['plan', 'steps'] },
        },
      },
      {
        id: 'execute',
        type: 'plan-loop',
        config: {
          executor: { type: 'agent', ...agentConfig(['default']) },
          stopPolicy: 'all-steps',
          // 执行的是**人确认过**的那份计划，而不是 plan 节点的原始输出
          planRef: { $ref: ['review', 'steps'] },
        },
      },
      {
        id: 'answer',
        type: 'synthesize',
        config: { observationsRef: { $ref: ['execute', 'observations'] } },
      },
    ],
    edges: [
      { from: 'start', to: 'plan' },
      { from: 'plan', to: 'review' },
      { from: 'review', to: 'execute', when: 'approved' },
      { from: 'execute', to: 'answer' },
    ],
  };
}

/**
 * 生成 Hybrid 预设
 * @returns 返回规划、动态 PlanLoop 与汇总组成的 Flow
 * @description 对应现有 HybridPlanReactGraph；PlanLoop 每步调用现有 StepEvaluator 决定是否提前结束。
 */
function hybridPreset(): FlowDefinition {
  return {
    schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
    kind: 'agent-flow',
    name: 'Hybrid',
    description: '规划后动态判断信息是否足够并汇总',
    policy: DEFAULT_POLICY,
    nodes: [
      { id: 'start', type: 'start', config: {} },
      { id: 'plan', type: 'plan', config: { maxSteps: 6 } },
      {
        id: 'execute',
        type: 'plan-loop',
        config: {
          executor: { type: 'agent', ...agentConfig(['default']) },
          stopPolicy: 'evaluate-after-step',
          planRef: { $ref: ['plan', 'steps'] },
        },
      },
      {
        id: 'answer',
        type: 'synthesize',
        config: { observationsRef: { $ref: ['execute', 'observations'] } },
      },
    ],
    edges: [
      { from: 'start', to: 'plan' },
      { from: 'plan', to: 'execute' },
      { from: 'execute', to: 'answer' },
    ],
  };
}

/**
 * 构造预设中复用的 Agent 配置
 * @param toolGroups 预设请求的工具组标识
 * @returns 返回继承任务默认模型的受限 Agent 配置
 * @description 模板不包含环境相关模型 ID，实际可用性留给阶段 3 的运行时闭集校验。
 */
function agentConfig(toolGroups: readonly string[]) {
  return {
    modelPreset: 'agent-default',
    toolGroups,
    skills: [],
    maxToolIterations: 4,
  };
}
