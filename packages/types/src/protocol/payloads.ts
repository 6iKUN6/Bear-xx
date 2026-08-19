/**
 * 流式事件载荷契约
 *
 * 描述的是 **SSE 线上形状**（`StreamTaskEventEnvelope.payload`），即前端与
 * `conversation-trace.mapper` 实际消费的那一层。
 *
 * ⚠️ 注意与 agent 层内部事件的区别：`message.delta` / `tool.call.delta` 在
 * `CommonChatAgentStreamEvent` 里是**顶层字段**（`event.delta`），到 stream-task
 * 层才被包进 `payload`。本文件只约束线上层，不约束 agent 层内部结构。
 *
 * 本轮（期 1）严格按**当前真实发送形状**描述，不改行为、不统一命名。已知的命名
 * 冗余与不一致在各处注释标出，留待收紧阶段处理——先让契约可见，再谈整理。
 */

import type { FlowNodeType } from "../agent-flow/definition.js";
import type { AgentStrategyMode } from "./strategy.js";
import type {
  ApprovalDecisionType,
  PlanReviewDecisionType,
} from "./approval-card.js";
// 映射表的计算属性键需要枚举成员作为字面量类型，故用值导入而非 import type
import { StreamTaskEventType } from "./events.js";

/**
 * 编排节点的公共展示字段
 * @description 前端用 `traceKey` 把同一逻辑单元的生命周期事件（start/done/error）
 * 折叠为一张卡片，用 `publicStatus` 作卡片标题。
 *
 * 并非所有事件都带齐这三个字段——`strategy.selected` 只有 `publicStatus`，
 * `skill.selected` 三个都没有，`model.call.done` 没有 `publicStatus`。
 * 这些事件不继承本接口，各自声明真实字段。
 */
export interface StreamNodePayloadBase {
  /** 节点标识 */
  nodeKey: string;
  /** 同一逻辑单元的生命周期事件共享此 key，前端据此折叠 */
  traceKey: string;
  /** 面向用户的中文进行态状态 */
  publicStatus: string;
}

/* ── 回答者指派 ─────────────────────────────────────────────── */

/**
 * 回答者指派来源
 * @description explicit=用户 @ 或胶囊指定；default=会话固定了默认回答者；
 * model=群聊自动路由由模型选出；fallback=路由不可用，兜底为首位成员。
 * fallback 与 model 的区分很重要：两者线上表现都是「某个成员回答了」，
 * 不标记就无法判断自动路由是否真的生效。
 */
export type AgentRouteSource = "explicit" | "default" | "model" | "fallback";

/**
 * `agent.routed` 载荷
 * @description 群聊未 @ 指定回答者时后端在建任务前选人。路由发生在流建立之前，
 * 实时通道走 `task.created`；本事件在任务执行开始时补发用于落 trace，
 * 使「谁被指派、为什么」在刷新后仍可回溯。
 */
export interface AgentRoutedPayload {
  /** 被指派的智能体 id */
  agentId: string;
  /** 被指派的智能体名称（落 trace 后无需再查库即可展示） */
  agentName?: string;
  /** 指派来源 */
  source: AgentRouteSource;
  /** 模型给出的一句话理由（仅 source=model 时有） */
  reason?: string;
}

/**
 * `task.created` 载荷
 * @description 合成事件（`prependEvent`，id 恒为 `'0'`），不入持久化流，刷新即失；
 * 需要回溯的归属信息由 `agent.routed` 承担。无回答者时整个 payload 为 undefined。
 *
 * ⚠️ 字段命名与 `AgentRoutedPayload` 不一致：此处叫 `routeSource`/`routeReason`，
 * 那边叫 `source`/`reason`；且 `autoRouted` 只在本事件存在。
 */
export interface TaskCreatedPayload {
  /** 本轮回答者 */
  agentId: string;
  /** 是否来自自动路由（非 @ 指定）；仅自动路由时下发 */
  autoRouted?: true;
  /** 自动路由理由；仅自动路由时下发 */
  routeReason?: string;
  /** 自动路由来源；仅自动路由时下发 */
  routeSource?: AgentRouteSource;
}

/* ── 编排 ───────────────────────────────────────────────────── */

/** `agent.loop.start` 载荷 */
export interface AgentLoopStartPayload extends StreamNodePayloadBase {
  /** 执行智能体标识（当前恒为 'common-chat-agent'） */
  agent: string;
  /** 本次执行策略 */
  strategy: AgentStrategyMode;
}

/**
 * `strategy.selected` 载荷
 * @description 由 `AgentLoopRunner.serializeDecision` 产出。
 * ⚠️ 不带 `nodeKey`/`traceKey`，故前端无法把它折叠进任何生命周期卡。
 */
export interface StrategySelectedPayload {
  /** 选中的策略 */
  mode: AgentStrategyMode;
  /** 决策置信度 */
  confidence: number;
  /** 决策理由 */
  reason: string;
  /** 装配的技能标识 */
  skills: string[];
  /** 装配的工具组标识 */
  toolGroups: string[];
  /** 步数预算 */
  maxSteps: number;
  /** 面向用户的中文状态 */
  publicStatus: string;
}

/**
 * `skill.selected` 载荷
 * @description ⚠️ 三个公共展示字段都没有，前端只能拼「能力 ${skill}」。
 */
export interface SkillSelectedPayload {
  /** 技能标识 */
  skill: string;
  /** 所属策略 */
  strategy: AgentStrategyMode;
}

/** `workflow.step.start` 载荷 */
export interface WorkflowStepStartPayload extends StreamNodePayloadBase {
  /** 所属策略 */
  strategy: AgentStrategyMode;
  /** 步骤标识：固定编排节点为 'create_plan'/'synthesize'，动态步骤为计划步骤 id */
  step: string;
  /** 步骤中文标题；固定节点取自静态表，动态步骤取步骤目标 */
  title?: string;
}

/**
 * `workflow.step.done` 载荷
 * @description 在 start 的字段上追加结果信息。`stepCount`/`steps`/`fromModel`
 * 仅 `step === 'create_plan'` 时下发。
 */
export interface WorkflowStepDonePayload extends WorkflowStepStartPayload {
  /** 语义化一句话结果摘要 */
  summary?: string;
  /** 规划出的步骤总数（仅 create_plan） */
  stepCount?: number;
  /** 各步骤目标文本（仅 create_plan） */
  steps?: string[];
  /** 计划是否来自模型（false = 降级为单步计划，仅 create_plan） */
  fromModel?: boolean;
}

/** `model.call.start` 载荷 */
export interface ModelCallStartPayload extends StreamNodePayloadBase {
  /** 模型名；请求未解析出模型时缺失 */
  model?: string;
  /** 供应商标识；同上 */
  provider?: string;
}

/**
 * `model.call.done` 载荷
 * @description ⚠️ 与 start 不对称：没有 `publicStatus`。
 */
export interface ModelCallDonePayload {
  nodeKey: string;
  traceKey: string;
  /** 模型名 */
  model?: string;
  /** 供应商标识 */
  provider?: string;
}

/* ── 工具调用 ───────────────────────────────────────────────── */

/**
 * 工具事件公共字段
 * @description ⚠️ `name` 与 `toolName` 由 `buildToolPayload` 同值双写，
 * 消费侧两个都能读到。保留双写以描述现状。
 */
export interface ToolCallPayloadBase extends StreamNodePayloadBase {
  /** 工具调用 id */
  toolCallId?: string;
  /** 工具名；首个 chunk 未带名称时缺失 */
  name?: string;
  /** 工具名（与 `name` 同值） */
  toolName?: string;
  /** 调用序号；done/error 在 callId 缺失或未登记时为哨兵值 -1 */
  index: number;
}

/** `tool.call.start` 载荷（此时入参尚未流出，无 args） */
export interface ToolCallStartPayload extends ToolCallPayloadBase {}

/**
 * `tool.call.delta` 载荷
 * @description ⚠️ 与 start/done/error 不同：由 stream-task 层重新包装，
 * 只有这四个字段，没有公共展示字段，也没有 `toolName`。
 */
export interface ToolCallDeltaPayload {
  toolCallId?: string;
  /** 工具名 */
  name?: string;
  /** 入参 JSON 片段（原始字符串，非结构化） */
  args?: string;
  index?: number;
}

/** 工具出参摘要：字符串归一为 `{text}`，标量归一为 `{value}`，对象走 JSON round-trip */
export type ToolOutputSummary =
  { text: string } | { value: string } | Record<string, unknown>;

/** `tool.call.done` 载荷 */
export interface ToolCallDonePayload extends ToolCallPayloadBase {
  /** 语义化一句话摘要，如「已使用 getWeather，成功查询到深圳天气」 */
  summary: string;
  /** 出参摘要；出参为 null/undefined 时缺失 */
  outputSummary?: ToolOutputSummary;
}

/** `tool.call.error` 载荷 */
export interface ToolCallErrorPayload extends ToolCallPayloadBase {
  /** 语义化一句话摘要，如「getWeather 调用失败：城市不存在」 */
  summary: string;
  /** 错误信息（必非空，缺省文案为「工具调用失败」） */
  message: string;
  /** 结构化错误；当前只有 message 一个字段 */
  error: { message: string };
}

/* ── 麦当劳订单 ─────────────────────────────────────────────── */

/** 麦当劳订单卡中的单个餐品。 */
export interface McDonaldsOrderItemPayload {
  /** 餐品名称 */
  name: string;
  /** 数量；官方未返回时为 null */
  quantity: number | null;
  /** 规格、特制或备注 */
  specification: string | null;
  /** 单价，采用字符串避免金额精度漂移 */
  unitPrice: string | null;
  /** 小计，采用字符串避免金额精度漂移 */
  subtotal: string | null;
  /** 餐品图片 URL；官方未返回时为 null */
  imageUrl: string | null;
}

/** 麦当劳订单的安全卡片载荷。 */
export interface McDonaldsOrderCardPayload {
  /** 本地订单 ID */
  id: string;
  /** 麦当劳官方订单号 */
  externalOrderId: string;
  /** 官方原始订单状态 */
  status: string | null;
  /** 面向展示的状态名称 */
  statusLabel: string | null;
  /** 门店名称 */
  storeName: string | null;
  /** 履约方式 */
  fulfillmentType: string | null;
  /** 实付金额字符串 */
  totalAmount: string | null;
  /** 优惠金额字符串 */
  discountAmount: string | null;
  /** 货币代码 */
  currency: string | null;
  /** 餐品快照 */
  items: McDonaldsOrderItemPayload[];
  /** 官方预计履约时间 */
  estimatedFulfillmentAt: string | null;
  /** 最近一次成功刷新时间 */
  lastRefreshedAt: string | null;
  /** 本地订单创建时间 */
  createdAt: string;
  /** 关联账号仍有效时才允许刷新状态或打开官方支付入口 */
  externalActionsAvailable: boolean;
}

/** `order.created` 载荷。 */
export interface OrderCreatedPayload {
  /** 新创建的安全订单卡片 */
  order: McDonaldsOrderCardPayload;
}

/* ── 消息 ───────────────────────────────────────────────────── */

/** `message.delta` 载荷（高频帧，只走 Redis 不入库） */
export interface MessageDeltaPayload {
  /** 文本增量 */
  delta: string;
}

/**
 * `message.done` 的运行指标
 * @description 全字段可选：终态恢复兜底流（Redis 帧已过期）走 `toRecord(resultPayload.metrics)`，
 * 可能是空对象。正常完成路径下除 `summaryMessageCount` 外都有值。
 */
export interface MessageDoneMetrics {
  /**
   * token 用量
   * @description 内层字段全可选，与 apps/api 的 `LlmTokenUsageMetrics` 声明保持一致
   * （正常路径下优先使用供应商逐调用 usage，类型层仍不作保证）。
   */
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    /** 推理模型在输出 token 中消耗的 reasoning token 数 */
    reasoningTokens?: number;
    /** 有任一次模型调用缺失供应商 usage 并改走估算时为 true */
    estimated?: boolean;
  };
  cache?: {
    memorySummaryHit?: boolean;
    providerPromptCacheHit?: boolean;
    contextCacheHit?: boolean;
    cachedInputTokens?: number;
  };
  durationMs?: number;
  messageCount?: number;
  /** 历史摘要覆盖的消息数；无摘要时缺失 */
  summaryMessageCount?: number;
  recentMessageCount?: number;
  toolCallCount?: number;
  modelCallCount?: number;
}

/** `message.done` 载荷 */
export interface MessageDonePayload {
  /** 最终正文；空回复时为兜底文案 */
  content: string;
  /** 异常提示；仅空回复等降级场景下发 */
  warning?: string;
  /** 运行指标 */
  metrics?: MessageDoneMetrics;
}

/* ── 任务生命周期 ───────────────────────────────────────────── */

/** `task.started` 无载荷 */
export type TaskStartedPayload = undefined;

/**
 * `task.completed` 载荷
 * @description 终态恢复兜底流下发同名事件但**不带 payload**，故消费侧需容忍缺失。
 */
export interface TaskCompletedPayload {
  /** 异常提示；仅降级场景下发 */
  warning?: string;
  /** 本次累计文本增量帧数 */
  deltaCount: number;
  /** 最终正文长度 */
  fullContentLength: number;
}

/** `task.canceled` 无载荷 */
export type TaskCanceledPayload = undefined;

/** `task.expired` 无载荷 */
export type TaskExpiredPayload = undefined;

/**
 * LLM / 任务失败的错误类别
 * @description 前后端共享的错误分类，用于前端按类别展示不同文案与是否提供「重试」。
 */
export type TaskErrorCategory =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "network"
  | "invalid"
  | "server"
  | "unknown";

/**
 * `task.error` 载荷
 * @description 人类可读的错误文本在信封的 `errorMessage` 上，不在 payload 里。
 */
export interface TaskErrorPayload {
  /** 错误类别 */
  category: TaskErrorCategory;
  /** 是否属于可重试类别（限流/超时/网络/5xx 为 true） */
  retryable: boolean;
  /** 原始 HTTP 状态码（如有） */
  status?: number;
}

/**
 * 错误类别 → 中文展示文案
 * @description 用 Record 保证新增类别时必须补文案（编译期穷尽校验）。
 */
export const TASK_ERROR_CATEGORY_LABELS: Record<TaskErrorCategory, string> = {
  rate_limit: "请求太频繁，请稍后重试",
  auth: "服务鉴权失败，请联系管理员",
  timeout: "响应超时，请重试",
  network: "网络异常，请检查连接后重试",
  invalid: "请求内容无法处理，请调整后再试",
  server: "服务暂时不可用，请稍后重试",
  unknown: "生成失败，请重试",
};

/**
 * 获取错误类别的中文展示文案
 * @param category 错误类别
 * @returns 返回中文文案；未知类别回退为 unknown 文案
 */
export function getTaskErrorCategoryLabel(
  category: TaskErrorCategory | undefined,
): string {
  return category
    ? (TASK_ERROR_CATEGORY_LABELS[category] ??
        TASK_ERROR_CATEGORY_LABELS.unknown)
    : TASK_ERROR_CATEGORY_LABELS.unknown;
}

/* ── 审批与会话 ─────────────────────────────────────────────── */

/**
 * `approval.required` 载荷
 * @description 工具执行前需要人工确认时下发，用于展示审批卡片。
 * ⚠️ 结构化审批卡（`approval-card.ts` 的 `ApprovalCardData`）设计完成但从未接线，
 * 故此处没有 `card` 字段——前端目前渲染的是工具名 + 原始 JSON 入参。
 */
export interface ApprovalRequiredPayload extends StreamNodePayloadBase {
  /** 工具名 */
  toolName: string;
  /** 序列化后的工具入参（供展示，edit 时可改）；序列化失败时缺失 */
  args?: string;
  /** 面向用户的审批说明 */
  description?: string;
  /** 允许的决定（缺省为 approve/reject） */
  allowedDecisions: ApprovalDecisionType[];
  /** 同一轮内多个待审批动作的序号 */
  index: number;
}

/**
 * `approval.resolved` 载荷
 * @description 用户提交决定后下发，与对应的 `approval.required` 共用 `traceKey`，
 * 使 trace 上那条「待人工确认」能被收敛为最终结果——否则历史里会永远停在等待态。
 */
export interface ApprovalResolvedPayload extends StreamNodePayloadBase {
  /** 人工决定 */
  decision: ApprovalDecisionType;
  /** 决定人 userId（审批属审计语义，必须记录是谁批的） */
  decidedBy: string;
  /** 被审批的工具名（从待审批 trace 项回填，便于回显时无需再查） */
  toolName?: string;
  /** 序列化后的改后入参（仅 decision=edit） */
  editedArgs?: string;
  /** 拒绝理由（仅 decision=reject 且用户填写时） */
  reason?: string;
}

/**
 * 审批决定 → 中文展示文案
 * @description 用 Record 保证新增决定类型时必须补文案（编译期穷尽校验）。
 */
export const APPROVAL_DECISION_LABELS: Record<ApprovalDecisionType, string> = {
  approve: "已通过",
  reject: "已拒绝",
  edit: "已修改参数后通过",
};

/**
 * `plan.review.required` 载荷
 * @description plan_execute 出计划后、执行第一步前下发，用于展示可确认/编辑的步骤清单。
 */
export interface PlanReviewRequiredPayload extends StreamNodePayloadBase {
  /** 待确认的步骤清单 */
  steps: PlanReviewStep[];
  /** 允许的决定（通过/编辑/打回/终止） */
  allowedDecisions: PlanReviewDecisionType[];
  /** 第几轮（打回重规划递增，首轮为 0），供 UI 提示 */
  revision: number;
}

/** 计划审批步骤（面向展示，仅 id + 目标文字） */
export interface PlanReviewStep {
  id: string;
  goal: string;
}

/**
 * `plan.review.resolved` 载荷
 * @description 用户提交计划决定后下发，与对应的 `plan.review.required` 共用 `traceKey`，
 * 使 trace 上那条「待确认计划」能收敛为最终结果。
 */
export interface PlanReviewResolvedPayload extends StreamNodePayloadBase {
  /** 人工决定 */
  decision: PlanReviewDecisionType;
  /** 决定人 userId（审计语义，必须记录） */
  decidedBy: string;
  /** 决定后的步骤数（仅 decision=edit 时有意义） */
  stepCount?: number;
  /** 打回意见（仅 decision=reject_replan 且用户填写时） */
  feedback?: string;
}

/* ── AgentFlow ─────────────────────────────────────────────── */

/** `flow.run.started` 载荷。 */
export interface FlowRunStartedPayload {
  /** 逻辑 Flow 标识。 */
  flowId: string;
  /** 本任务锁定的不可变 Flow 版本标识。 */
  flowVersionId: string;
  /** 忽略画布 layout 后计算的 Definition 摘要。 */
  digest: string;
}

/** `flow.node.started` 载荷。 */
export interface FlowNodeStartedPayload {
  /** Flow 节点标识。 */
  nodeKey: string;
  /** 节点类型；仅允许 V1 闭集。 */
  nodeType: FlowNodeType;
  /** 面向用户和 trace 展示的节点标题。 */
  title: string;
  /** 同一节点生命周期事件共享的 trace 标识。 */
  traceKey: string;
}

/** `flow.node.completed` 载荷。 */
export interface FlowNodeCompletedPayload {
  /** Flow 节点标识。 */
  nodeKey: string;
  /** 节点类型；仅允许 V1 闭集。 */
  nodeType: FlowNodeType;
  /** 与开始事件关联的 trace 标识。 */
  traceKey: string;
  /** 不含敏感数据的完成摘要。 */
  summary: string;
  /** 节点本次执行耗时，单位毫秒。 */
  durationMs: number;
}

/** `flow.node.failed` 载荷。 */
export interface FlowNodeFailedPayload {
  /** Flow 节点标识。 */
  nodeKey: string;
  /** 节点类型；仅允许 V1 闭集。 */
  nodeType: FlowNodeType;
  /** 与开始事件关联的 trace 标识。 */
  traceKey: string;
  /** 可供端侧展示与重试策略判断的错误分类。 */
  category: TaskErrorCategory;
  /** 是否允许由运行时按照策略自动重试。 */
  retryable: boolean;
}

/** Flow 工具审批批次中的单个安全展示请求。 */
export interface FlowToolApprovalRequest {
  /** 已经由后端脱敏的工具名称。 */
  toolName: string;
  /** 已脱敏的序列化工具入参。 */
  args?: string;
  /** 面向用户的风险或操作说明。 */
  description?: string;
  /** 当前审批批次中的动作序号。 */
  index: number;
}

/** Flow 工具审批批次的安全展示载荷。 */
export interface FlowToolApprovalPayload {
  kind: "tool";
  /** 同一轮 LangGraph interrupt 中必须一起决议的工具请求。 */
  requests: FlowToolApprovalRequest[];
  /** 后端固定的可提交决定。 */
  allowedDecisions: ApprovalDecisionType[];
}

/** Flow 计划审批的安全展示载荷。 */
export interface FlowPlanReviewApprovalPayload {
  kind: "plan-review";
  /** 待人工确认的计划步骤。 */
  steps: PlanReviewStep[];
  /** 当前计划的修订轮次。 */
  revision: number;
  /** 后端固定的可提交决定。 */
  allowedDecisions: PlanReviewDecisionType[];
}

/** Flow 人工审批的可判别展示载荷。 */
export type FlowApprovalPayload =
  FlowToolApprovalPayload | FlowPlanReviewApprovalPayload;

/** `flow.waiting_human` 载荷。 */
export interface FlowWaitingHumanPayload {
  /** 审批业务事实的稳定标识；后续 Temporal Signal 只传该标识。 */
  approvalId: string;
  /** 命中人工等待的 Flow 节点标识。 */
  nodeKey: string;
  /** 关联审批 trace 的稳定标识。 */
  traceKey: string;
  /** 供审批卡片直接渲染的安全展示信息。 */
  approval: FlowApprovalPayload;
  /** 审批到期时间的 ISO 8601 字符串。 */
  expiresAt: string;
}

/** Flow 恢复的触发来源。 */
export type FlowRunResumeReason = "approval" | "retry" | "manual" | "recovery";

/** `flow.run.resumed` 载荷。 */
export interface FlowRunResumedPayload {
  /** 面向客户端的可见恢复序号；不等同于 Temporal 的内部 attempt。 */
  runSequence: number;
  /** 本次恢复的受限来源。 */
  reason: FlowRunResumeReason;
}

/**
 * `conversation.title.updated` 载荷
 * @description 新会话首轮时后端与主回答并行生成 AI 标题，生成后经当前任务的 SSE 下发，
 * 前端可在回答流式输出期间就更新标题展示。
 */
export interface ConversationTitleUpdatedPayload {
  /** 会话 id */
  conversationId: string;
  /** 生成的标题 */
  title: string;
}

/* ── 映射表 ─────────────────────────────────────────────────── */

/**
 * 事件类型 → 线上载荷
 * @description 唯一事实源。新增事件必须在此登记，否则 `StreamTaskWireEvent`
 * 不接受该类型，发送侧编译报错。
 */
export interface StreamTaskPayloadMap {
  [StreamTaskEventType.AgentRouted]: AgentRoutedPayload;
  [StreamTaskEventType.AgentLoopStart]: AgentLoopStartPayload;
  [StreamTaskEventType.StrategySelected]: StrategySelectedPayload;
  [StreamTaskEventType.SkillSelected]: SkillSelectedPayload;
  [StreamTaskEventType.WorkflowStepStart]: WorkflowStepStartPayload;
  [StreamTaskEventType.WorkflowStepDone]: WorkflowStepDonePayload;
  [StreamTaskEventType.ModelCallStart]: ModelCallStartPayload;
  [StreamTaskEventType.ModelCallDone]: ModelCallDonePayload;
  [StreamTaskEventType.ToolCallStart]: ToolCallStartPayload;
  [StreamTaskEventType.ToolCallDelta]: ToolCallDeltaPayload;
  [StreamTaskEventType.ToolCallDone]: ToolCallDonePayload;
  [StreamTaskEventType.ToolCallError]: ToolCallErrorPayload;
  [StreamTaskEventType.OrderCreated]: OrderCreatedPayload;
  [StreamTaskEventType.MessageDelta]: MessageDeltaPayload;
  [StreamTaskEventType.MessageDone]: MessageDonePayload;
  [StreamTaskEventType.TaskCreated]: TaskCreatedPayload;
  [StreamTaskEventType.TaskStarted]: TaskStartedPayload;
  [StreamTaskEventType.TaskCompleted]: TaskCompletedPayload;
  [StreamTaskEventType.TaskError]: TaskErrorPayload;
  [StreamTaskEventType.TaskExpired]: TaskExpiredPayload;
  [StreamTaskEventType.TaskCanceled]: TaskCanceledPayload;
  [StreamTaskEventType.ApprovalRequired]: ApprovalRequiredPayload;
  [StreamTaskEventType.ApprovalResolved]: ApprovalResolvedPayload;
  [StreamTaskEventType.PlanReviewRequired]: PlanReviewRequiredPayload;
  [StreamTaskEventType.PlanReviewResolved]: PlanReviewResolvedPayload;
  [StreamTaskEventType.ConversationTitleUpdated]: ConversationTitleUpdatedPayload;
  [StreamTaskEventType.FlowRunStarted]: FlowRunStartedPayload;
  [StreamTaskEventType.FlowNodeStarted]: FlowNodeStartedPayload;
  [StreamTaskEventType.FlowNodeCompleted]: FlowNodeCompletedPayload;
  [StreamTaskEventType.FlowNodeFailed]: FlowNodeFailedPayload;
  [StreamTaskEventType.FlowWaitingHuman]: FlowWaitingHumanPayload;
  [StreamTaskEventType.FlowRunResumed]: FlowRunResumedPayload;
}

/**
 * 线上事件的判别联合
 * @description 对象字面量赋给它时，`type` 与 `payload` 必须匹配，多字段/少字段/类型错
 * 均编译报错——不需要额外的工厂函数包裹。
 */
export type StreamTaskWireEvent = {
  [K in keyof StreamTaskPayloadMap]: {
    type: K;
    payload: StreamTaskPayloadMap[K];
  };
}[keyof StreamTaskPayloadMap];

/** 按事件类型取出对应载荷类型 */
export type StreamTaskPayloadOf<K extends keyof StreamTaskPayloadMap> =
  StreamTaskPayloadMap[K];

/**
 * 任意事件的线上载荷
 * @description 仅供**泛化消费**场景使用（如 trace 映射：按 key 动态取展示字段，
 * 不关心具体事件）。发送侧不要用它——那会丢掉 type 与 payload 的绑定，
 * 退回到「字段名写错也不报错」。
 */
export type AnyStreamTaskPayload =
  StreamTaskPayloadMap[keyof StreamTaskPayloadMap];
