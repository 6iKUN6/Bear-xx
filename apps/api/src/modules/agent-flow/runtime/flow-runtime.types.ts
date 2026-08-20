import type {
  FlowDefinition,
  FlowNodeType,
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
  type: FlowNodeType;
  next: Readonly<Record<string, string>>;
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
  planLoopPolicy: {
    stopPolicy: FlowPlanLoopStopPolicy;
    planReview: 'disabled';
    maxSteps: number;
  };
  executor: Omit<CompiledAgentFlowNode, 'key' | 'type' | 'next'>;
}

/** 编译后的计划审批节点。 */
export interface CompiledApprovalFlowNode extends CompiledFlowNodeBase {
  type: 'approval';
  kind: 'plan-review';
}

/** 编译后的汇总节点。 */
export interface CompiledSynthesizeFlowNode extends CompiledFlowNodeBase {
  type: 'synthesize';
}

/** 编译后的节点闭集。 */
export type CompiledFlowNode =
  | CompiledAgentFlowNode
  | CompiledPlanFlowNode
  | CompiledPlanLoopFlowNode
  | CompiledApprovalFlowNode
  | CompiledSynthesizeFlowNode;

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
