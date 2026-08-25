import type {
  FlowApprovalPolicy,
  FlowConditionCase,
  FlowRef,
  FlowDefinition,
  FlowPlanLoopStopPolicy,
} from '@litter-bear/types/agent-flow';

/** Flow 运行时校验错误。 */
export interface FlowRuntimeValidationError {
  path: string;
  rule: string;
  message: string;
}

/** Flow 运行时校验结果。 */
export interface FlowRuntimeValidationResult {
  valid: boolean;
  errors: FlowRuntimeValidationError[];
}

/** Flow 进入实际任务前必须锁定的上下文。 */
export interface FlowTaskRuntimeContext {
  phase: 'task';
  agentDefaultModelPreset: string | null;
  mcdonaldsCredentialId?: string;
}

/** Flow 发布前仅依赖静态闭集的上下文。 */
export interface FlowPublishRuntimeContext {
  phase: 'publish';
}

/** Flow 运行时校验上下文。 */
export type FlowRuntimeValidationContext =
  FlowPublishRuntimeContext | FlowTaskRuntimeContext;

/** 编译后节点共享字段。 */
export interface CompiledFlowNodeBase {
  key: string;
  /** Definition 里的显示别名；缺省时展示层回退到节点类型标题 */
  name?: string;
}

/** 编译后的 Agent 节点。 */
export interface CompiledAgentFlowNode extends CompiledFlowNodeBase {
  type: 'agent';
  modelPreset: string;
  toolGroups: readonly string[];
  skills: readonly string[];
  maxToolIterations: number;
  approvalToolNames: readonly string[];
}

/** 编译后的 Plan 节点。 */
export interface CompiledPlanFlowNode extends CompiledFlowNodeBase {
  type: 'plan';
  maxSteps: number;
}

/** 编译后的 PlanLoop 节点。 */
export interface CompiledPlanLoopFlowNode extends CompiledFlowNodeBase {
  type: 'plan-loop';
  /** 要执行哪份计划；校验期已保证它指向某个上游节点的 steps */
  planRef: FlowRef;
  planLoopPolicy: {
    stopPolicy: FlowPlanLoopStopPolicy;
    planReview: 'disabled';
    maxSteps: number;
  };
  executor: Omit<CompiledAgentFlowNode, 'key' | 'type'>;
}

/** 编译后的计划审批节点。 */
export interface CompiledApprovalFlowNode extends CompiledFlowNodeBase {
  type: 'approval';
  kind: 'plan-review';
  /** 门禁策略；model 由模型判断是否需要人工确认，失败一律闭合为需要 */
  policy: FlowApprovalPolicy;
  /** 要审的是哪份计划；校验期已保证它指向 plan 节点的 steps */
  planRef: FlowRef;
}

/** 编译后的汇总节点。 */
export interface CompiledSynthesizeFlowNode extends CompiledFlowNodeBase {
  type: 'synthesize';
  /** 要汇总谁的步骤观察；缺省即普通汇总 */
  observationsRef?: FlowRef;
  /** 汇总使用的模型；编译期已把 agent-default 解析成具体预设 */
  modelPreset: string;
}

/** 编译后的起始节点。 */
export interface CompiledStartFlowNode extends CompiledFlowNodeBase {
  type: 'start';
}

/** 编译后的汇聚节点。 */
export interface CompiledJoinFlowNode extends CompiledFlowNodeBase {
  type: 'join';
  waitFor: readonly string[];
  joinPolicy: 'all' | 'any';
}

/** 编译后的条件分支节点。 */
export interface CompiledConditionFlowNode extends CompiledFlowNodeBase {
  type: 'condition';
  cases: readonly FlowConditionCase[];
}

/** 编译后的节点闭集。 */
export type CompiledFlowNode =
  | CompiledStartFlowNode
  | CompiledAgentFlowNode
  | CompiledPlanFlowNode
  | CompiledPlanLoopFlowNode
  | CompiledApprovalFlowNode
  | CompiledSynthesizeFlowNode
  | CompiledConditionFlowNode
  | CompiledJoinFlowNode;

/** 已冻结且可被节点执行器消费的 Flow 计划。 */
export interface CompiledFlowPlan {
  definition: FlowDefinition;
  entryNodeKey: string;
  nodes: readonly CompiledFlowNode[];
}

/** 编译成功或失败的判别结果。 */
export type FlowCompilationResult =
  | { success: true; plan: CompiledFlowPlan }
  | { success: false; errors: FlowRuntimeValidationError[] };
