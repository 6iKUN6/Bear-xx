/**
 * HITL 审批卡片数据契约（设计稿，待 review 后接线）
 *
 * 设计原则（schema-driven，禁止 AI 输出 HTML）：
 * 1. 字段分级——交互语义字段（decisions、按钮行为）只能由后端代码组装，
 *    AI 永远不可触碰；展示文案字段（title/summary/warnings/riskLevel）
 *    允许 AI 结构化生成，prompt injection 最多影响措辞、动不了交互结构。
 * 2. 双通道兜底——AI 结构化输出必须过校验（后端 zod/class-validator）,
 *    校验不过或模型不可用时回退到规则模板拼装（source 标记来源），
 *    审批功能不依赖 AI 可用性。
 * 3. 向前兼容——version 锚点 + 前端忽略未知字段，后端加字段不炸旧客户端
 *    （小程序发版慢，此条硬性）。
 */
/** 人工审批决定类型（P5 HITL）；定义在此避免与 index 的 export * 成环 */
export type ApprovalDecisionType = 'approve' | 'reject' | 'edit';

/**
 * 计划审批决定类型（plan_execute 出计划后、执行前的人工关卡）
 * @description 与工具审批（ApprovalDecisionType）是两套语义，独立定义避免混用：
 * approve=按当前计划执行；edit=用改后步骤执行；reject_replan=带意见打回重新规划；
 * reject_terminate=直接终止任务。
 */
export type PlanReviewDecisionType =
  | 'approve'
  | 'edit'
  | 'reject_replan'
  | 'reject_terminate';

/** 计划审批决定（前端提交、后端恢复时消费） */
export interface PlanReviewDecision {
  decision: PlanReviewDecisionType;
  /** decision=edit 时的完整步骤列表（改后的文字 + 末尾追加的） */
  editedSteps?: { goal: string }[];
  /** decision=reject_replan 时的意见，拼进 planner 提示词重新拆解 */
  feedback?: string;
}

/** 计划审批决定 → 中文展示文案（Record 保证新增类型必须补文案） */
export const PLAN_REVIEW_DECISION_LABELS: Record<
  PlanReviewDecisionType,
  string
> = {
  approve: '已确认计划',
  edit: '已修改计划后执行',
  reject_replan: '已打回重新规划',
  reject_terminate: '已终止任务',
};

export const APPROVAL_CARD_VERSION = 1 as const;

/** 风险等级：前端映射颜色/图标（low=中性 medium=警示 high=危险） */
export type ApprovalRiskLevel = 'low' | 'medium' | 'high';

/** 参数展示行：由后端代码从工具 args 组装，AI 不参与结构 */
export interface ApprovalCardField {
  label: string;
  value: string;
}

/** 卡片文案来源：ai=模型结构化生成（已过校验）；template=规则模板兜底 */
export type ApprovalCardSource = 'ai' | 'template';

/**
 * 审批卡片数据：随 approval.required 事件的 payload.card 下发。
 * 现有 ApprovalRequiredPayload 的 toolCallId/allowedDecisions 等
 * 控制字段保持不变，本结构只负责“展示层”。
 */
export interface ApprovalCardData {
  version: typeof APPROVAL_CARD_VERSION;
  /** 卡片标题，如「调用天气查询」；AI 可生成 */
  title: string;
  /** 风险等级；AI 可评估，校验失败回退 medium */
  riskLevel: ApprovalRiskLevel;
  /** 人话说明：这次调用要做什么、影响什么；AI 可生成 */
  summary: string;
  /** 参数明细行；代码从 args 组装（截断/脱敏在后端做） */
  fields: ApprovalCardField[];
  /** 需要用户特别注意的点；AI 可生成，条数后端裁剪 */
  warnings?: string[];
  /** 允许的决定；只能来自后端代码（CapabilityRegistry 配置） */
  decisions: ApprovalDecisionType[];
  /** 文案来源标记，排查“AI 措辞异常”时用 */
  source: ApprovalCardSource;
}

/** AI 允许生成的字段子集（结构化输出的目标 schema） */
export type ApprovalCardAiFields = Pick<
  ApprovalCardData,
  'title' | 'riskLevel' | 'summary' | 'warnings'
>;
