/** 模型思考能力的统一开关。 */
export type ReasoningActivation = "enabled" | "disabled" | "auto";

/** 跨供应商统一的思考强度闭集。 */
export type ReasoningEffort =
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 一次模型调用的供应商无关思考选择。
 * @description 具体模型支持哪些字段和值由服务端能力目录决定；调用方不能据模型名自行推断。
 */
export interface ReasoningSelection {
  readonly activation?: ReasoningActivation;
  readonly effort?: ReasoningEffort;
  readonly budgetTokens?: number | "auto";
}

/** 写入 JSON 列时使用的可演进信封。 */
export interface PersistedReasoningConfig {
  readonly version: 1;
  readonly selection: ReasoningSelection;
}
