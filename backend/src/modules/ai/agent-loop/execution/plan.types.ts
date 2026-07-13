/** 单个计划步骤 */
export interface PlanStep {
  /** 步骤标识，用于事件 nodeKey/traceKey */
  id: string;
  /** 步骤目标描述 */
  goal: string;
  /** 该步骤建议使用的工具名（仅作提示，不强制） */
  suggestedTools?: string[];
}

/** 任务计划 */
export interface AgentPlan {
  steps: PlanStep[];
  /** 是否来自模型规划（false 表示走了兜底单步计划） */
  fromModel: boolean;
}

/** 单步执行结果 */
export interface StepExecutionResult {
  /** 该步骤产出的助手文本（作为观察，不直接作为最终答案） */
  text: string;
  /** 该步骤是否触发过工具调用 */
  hadToolCalls: boolean;
}
