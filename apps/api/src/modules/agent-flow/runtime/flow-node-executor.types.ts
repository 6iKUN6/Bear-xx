import type { FlowNode } from '@litter-bear/types/agent-flow';

/** 节点执行时的冻结输入。 */
export interface FlowNodeExecutionInput {
  taskId: string;
  nodeKey: string;
  inputs: Readonly<Record<string, unknown>>;
  snapshot: Readonly<Record<string, unknown>>;
}

/** 节点执行后的统一结果。 */
export interface FlowNodeExecutionResult {
  outcome: 'default' | 'approved' | 'true' | 'false' | 'waiting_human';
  summary?: string;
  outputs?: Readonly<Record<string, unknown>>;
  approval?: {
    kind: 'plan-review' | 'tool';
    approvalId: string;
  };
}

/** Flow 节点执行器稳定接口。 */
export interface FlowNodeExecutor<TNode extends FlowNode = FlowNode> {
  readonly nodeType: TNode['type'];

  /**
   * 执行一个已编译的 Flow 节点
   * @param node 当前不可变节点定义
   * @param input 当前任务的冻结输入和小型运行快照
   * @returns 返回受限分支、可展示摘要和结构化输出
   * @description 执行器不得通过节点配置反射类名、加载模块或执行动态代码；审批由 waiting_human 明确表示。
   */
  execute(
    node: TNode,
    input: FlowNodeExecutionInput,
  ): Promise<FlowNodeExecutionResult>;
}
