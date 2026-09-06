// 中文文案与载荷契约来自前后端共享包（唯一事实源）
import {
  STREAM_TASK_EVENT_LABELS as EVENT_LABELS,
  type StreamTaskPayloadMap,
} from "@litter-bear/types/protocol";
import {
  StreamTaskEventType,
  type StreamTaskEvent,
} from "../services/stream/stream-event.types";

/**
 * 工具调用生命周期事件：start / done / error 共享同一 traceKey，
 * 折叠为同一张反馈卡片，随状态原地更新（不为每个阶段新开卡片）。
 */
const TOOL_LIFECYCLE_TYPES = new Set<StreamTaskEventType>([
  StreamTaskEventType.ToolCallStart,
  StreamTaskEventType.ToolCallDone,
  StreamTaskEventType.ToolCallError,
]);

/**
 * 编排步骤生命周期事件：Flow 节点与工作流步骤的 start / done / fail 共享
 * 同一 traceKey，折叠为同一行（Codex 风格：一个节点一行，状态原地 ✓/●/✗）。
 */
const NODE_LIFECYCLE_TYPES = new Set<StreamTaskEventType>([
  StreamTaskEventType.WorkflowStepStart,
  StreamTaskEventType.WorkflowStepDone,
  StreamTaskEventType.FlowNodeStarted,
  StreamTaskEventType.FlowNodeCompleted,
  StreamTaskEventType.FlowNodeFailed,
]);

const EVENT_TONES: Partial<
  Record<StreamTaskEventType, MessageStreamEventTone>
> = {
  [StreamTaskEventType.WorkflowStepDone]: "success",
  [StreamTaskEventType.ModelCallDone]: "success",
  [StreamTaskEventType.ToolCallDone]: "success",
  [StreamTaskEventType.MessageDone]: "success",
  [StreamTaskEventType.TaskCompleted]: "success",
  [StreamTaskEventType.TaskExpired]: "warning",
  [StreamTaskEventType.TaskCanceled]: "warning",
  [StreamTaskEventType.ToolCallError]: "error",
  [StreamTaskEventType.TaskError]: "error",
  [StreamTaskEventType.PlanReviewResolved]: "success",
  [StreamTaskEventType.FlowNodeCompleted]: "success",
  [StreamTaskEventType.FlowNodeFailed]: "error",
};

export function toMessageStreamFeedback(
  event: StreamTaskEvent,
): MessageStreamEventFeedback | null {
  // 文本分片与工具入参分片都是逐 token 的中间态，不各自成卡：
  // 文本走消息气泡，工具入参由 start→done 的同一张生命周期卡承载。
  if (
    event.type === StreamTaskEventType.MessageDelta ||
    event.type === StreamTaskEventType.ToolCallDelta
  ) {
    return null;
  }

  const type = event.type as StreamTaskEventType;
  const payload = readPayload(event.data.payload);
  const publicStatus = readString(payload.publicStatus);
  let title = publicStatus || EVENT_LABELS[type] || "任务状态更新";
  // 摘要优先：后端在 done/error 的 payload.summary 里给出「已使用 xx，成功查询到…」，
  // 其次才回退到按事件类型拼装的入参/模型等细节。
  const detail =
    event.data.errorMessage ||
    readString(payload.summary) ||
    readEventDetail(type, payload);
  const toolSummary =
    type === StreamTaskEventType.ToolCallDone
      ? readString(payloadOf(payload, StreamTaskEventType.ToolCallDone).summary)
      : undefined;

  // Flow 节点：started/failed 带人话节点标题（管理员别名优先），completed 带耗时。
  // 这些事件按 traceKey 折叠成一行，此处把人话标题与耗时挂到反馈事件上供行展示。
  let durationMs: number | null | undefined;
  if (type === StreamTaskEventType.FlowNodeStarted) {
    const p = payloadOf(payload, StreamTaskEventType.FlowNodeStarted);
    title = readString(p.title) ?? title;
  } else if (type === StreamTaskEventType.FlowNodeCompleted) {
    const p = payloadOf(payload, StreamTaskEventType.FlowNodeCompleted);
    durationMs = p.durationMs ?? undefined;
  } else if (type === StreamTaskEventType.FlowNodeFailed) {
    const p = payloadOf(payload, StreamTaskEventType.FlowNodeFailed);
    title = readString(p.title) ?? title;
  }

  const outputSummary =
    type === StreamTaskEventType.ToolCallDone
      ? payloadOf(payload, StreamTaskEventType.ToolCallDone).outputSummary
      : undefined;

  return {
    id: resolveFeedbackId(event, type, payload),
    type: event.type,
    title,
    detail,
    tone: EVENT_TONES[type] || "info",
    display: isTextDisplayEvent(type) ? "text" : "panel",
    stage: traceStageFromEvent(type),
    toolName: readString(payload.toolName) ?? readString(payload.name),
    toolSummary,
    durationMs,
    outputSummary,
    updatedAt: Date.now(),
  };
}

export function buildStreamFeedbackFromTrace(
  trace?: MessageTraceItem[],
): MessageStreamFeedbackState | undefined {
  const events = trace
    ?.slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map(toMessageStreamFeedbackFromTrace)
    .filter((event): event is MessageStreamEventFeedback => Boolean(event));

  if (!events?.length) {
    return undefined;
  }

  const current = findLastInfoEvent(events) || events[events.length - 1];

  return {
    current,
    events,
    expanded: false,
  };
}

export function toMessageStreamFeedbackFromTrace(
  traceItem: MessageTraceItem,
): MessageStreamEventFeedback | null {
  if (!traceItem.title?.trim()) {
    return null;
  }

  return {
    id: traceItem.id,
    type: traceItem.type,
    title: traceItem.title,
    // 耗时走独立的 durationMs 字段（行尾 tabular-nums 展示），不再拼进摘要文案
    detail: traceItem.summary || undefined,
    tone: traceStatusTone(traceItem.status),
    // 与实时流保持一致：指派和收尾都是一行小字，刷新回显后不该变回卡片
    display:
      traceItem.type === "MESSAGE_FINALIZE" ||
      traceItem.type === "AGENT_ROUTING"
        ? "text"
        : "panel",
    stage: traceStageFromTraceItem(traceItem),
    toolName: traceItem.toolName ?? undefined,
    toolSummary:
      traceItem.type === "TOOL_CALL" &&
      traceItem.status.toUpperCase() === "SUCCESS"
        ? traceItem.summary ?? undefined
        : undefined,
    durationMs: traceItem.durationMs ?? undefined,
    inputSummary: traceItem.inputSummary,
    outputSummary: traceItem.outputSummary,
    updatedAt: Date.now(),
  };
}

/**
 * 生成收起态的流式状态文案
 * @param current 当前正在处理的轨迹节点
 * @param events 本轮已接收的全部轨迹节点
 * @returns 返回当前节点文案，并在存在时附加最近一次工具安全摘要
 * @description 收起态仅保留用户可读的 loop/任务描述和工具完成摘要，
 * 不拼接工具入参，避免泄露冗长且难读的调用参数。
 */
export function formatStreamFeedbackStatus(
  current: MessageStreamEventFeedback,
  events: MessageStreamEventFeedback[],
) {
  const currentDetail = shouldHideToolArguments(current)
    ? current.toolSummary
    : current.detail;
  const latestToolSummary = [...events]
    .reverse()
    .find((event) => event.id !== current.id && event.toolSummary)?.toolSummary;

  return joinParts([
    current.title,
    currentDetail,
    latestToolSummary && `工具反馈：${shortenStatusText(latestToolSummary)}`,
  ]);
}

function shouldHideToolArguments(event: MessageStreamEventFeedback) {
  return (
    event.tone !== "error" &&
    (event.type === "TOOL_CALL" ||
      event.type === StreamTaskEventType.ToolCallStart ||
      event.type === StreamTaskEventType.ToolCallDone)
  );
}

function shortenStatusText(value: string, maxLength = 48) {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}…`
    : value;
}

/**
 * 计算反馈卡片 id
 * @param event 原始流事件
 * @param type 事件类型
 * @param payload 事件载荷
 * @returns 返回用于去重/折叠的稳定 id
 * @description 工具生命周期事件（start/done/error）用后端下发的 traceKey（按 toolCallId 稳定），
 * 使同一次工具调用的多个阶段折叠进同一张卡；其余事件保持每条唯一，互不合并。
 */
function resolveFeedbackId(
  event: StreamTaskEvent,
  type: StreamTaskEventType,
  payload: Record<string, unknown>,
): string {
  if (TOOL_LIFECYCLE_TYPES.has(type)) {
    const traceKey = readString(payload.traceKey);
    if (traceKey) {
      return `tool-${traceKey}`;
    }
  }

  // 编排步骤（Flow 节点 / 工作流步骤）按 traceKey 折叠为一行
  if (NODE_LIFECYCLE_TYPES.has(type)) {
    const traceKey = readString(payload.traceKey);
    if (traceKey) {
      return `node-${traceKey}`;
    }
  }

  return `${event.rawId || event.id || Date.now()}-${event.type}`;
}

/**
 * 是否用一行小字而非卡片展示
 * @description 指派与终态都属于「一句话说完就过去」的信息，套上带状态点和
 * 展开箭头的卡片会显得比实际重要。
 */
function isTextDisplayEvent(type: StreamTaskEventType) {
  return (
    type === StreamTaskEventType.AgentRouted ||
    type === StreamTaskEventType.TaskCompleted ||
    type === StreamTaskEventType.TaskCanceled ||
    type === StreamTaskEventType.TaskExpired
  );
}

function readPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * 按事件类型取出对应契约的载荷
 * @param payload 原始载荷（来自线上 JSON）
 * @returns 返回该事件的载荷契约视图
 * @description 线上数据不可信，字段可能缺失（旧版后端、被截断），故收敛为 Partial。
 * 断言只此一处；之后按契约取字段，写错字段名编译期即报错，
 * 不再是先前 `readString(payload.任意名)` 永远静默返回 undefined。
 */
function payloadOf<K extends StreamTaskEventType>(
  payload: Record<string, unknown>,
  _type: K,
): Partial<StreamTaskPayloadMap[K]> {
  return payload as Partial<StreamTaskPayloadMap[K]>;
}

function readEventDetail(
  type: StreamTaskEventType,
  raw: Record<string, unknown>,
) {
  switch (type) {
    case StreamTaskEventType.AgentRouted: {
      const payload = payloadOf(raw, StreamTaskEventType.AgentRouted);
      return joinParts([
        payload.agentName,
        // 自动路由带模型理由；降级时明确告知未生效，避免「怎么老是同一个人回答」无从判断
        payload.source === "fallback"
          ? "自动分配不可用，已交给首位成员"
          : payload.reason,
      ]);
    }
    case StreamTaskEventType.StrategySelected: {
      const payload = payloadOf(raw, StreamTaskEventType.StrategySelected);
      // 不透出策略名等内部术语，只展示模型给出的理由
      return payload.reason;
    }
    case StreamTaskEventType.SkillSelected: {
      // 能力/策略标识属内部术语，不展示
      return undefined;
    }
    case StreamTaskEventType.WorkflowStepStart:
    case StreamTaskEventType.WorkflowStepDone: {
      const payload = payloadOf(raw, StreamTaskEventType.WorkflowStepDone);
      // 不透出策略名等内部术语，只展示人话步骤标题
      return payload.title ?? payload.summary ?? undefined;
    }
    case StreamTaskEventType.ModelCallStart:
    case StreamTaskEventType.ModelCallDone: {
      const payload = payloadOf(raw, StreamTaskEventType.ModelCallStart);
      return joinParts([payload.provider, payload.model]);
    }
    case StreamTaskEventType.ToolCallStart:
    case StreamTaskEventType.ToolCallDelta:
    case StreamTaskEventType.ToolCallDone:
    case StreamTaskEventType.ToolCallError: {
      const payload = payloadOf(raw, StreamTaskEventType.ToolCallDelta);
      return joinParts([payload.name && `工具 ${payload.name}`, payload.args]);
    }
    case StreamTaskEventType.ApprovalRequired: {
      const payload = payloadOf(raw, StreamTaskEventType.ApprovalRequired);
      return joinParts([
        payload.toolName && `工具 ${payload.toolName}`,
        payload.description,
      ]);
    }
    case StreamTaskEventType.PlanReviewRequired: {
      const payload = payloadOf(raw, StreamTaskEventType.PlanReviewRequired);
      return payload.steps?.length
        ? `共 ${payload.steps.length} 步待确认`
        : undefined;
    }
    case StreamTaskEventType.TaskCompleted:
      return undefined;
    case StreamTaskEventType.MessageDone:
      return payloadOf(raw, StreamTaskEventType.MessageDone).warning;
    default:
      return undefined;
  }
}

function joinParts(parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(" · ") || undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findLastInfoEvent(events: MessageStreamEventFeedback[]) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.tone === "info") {
      return event;
    }
  }

  return undefined;
}

function traceStatusTone(status: string): MessageStreamEventTone {
  const normalizedStatus = status.toUpperCase();
  if (normalizedStatus === "SUCCESS") {
    return "success";
  }

  if (normalizedStatus === "ERROR") {
    return "error";
  }

  if (normalizedStatus === "SKIPPED" || normalizedStatus === "CANCELED") {
    return "warning";
  }

  return "info";
}

/** Codex 风格执行轨迹行 */
export interface StreamTraceRow {
  /** 行 key（折叠后的反馈事件 id） */
  key: string;
  /** 行状态：进行中 / 成功 / 失败 */
  status: "run" | "done" | "fail";
  /** 等宽动作名（工具名 / 节点人话标题） */
  name: string;
  /** 一句话人话摘要 */
  summary?: string;
  /** 该步耗时（毫秒） */
  durationMs?: number | null;
  /** 展开细节（入参/出参摘要的易读文本），无则不显示展开 caret */
  detail?: string;
}

/**
 * 编排/生命周期/消息终态等「非步骤」事件
 * @description 这些是任务骨架或专有卡片的来源，不作为执行轨迹行展示：
 * 指派/策略/能力属内部路由，审批与订单有专有卡片，任务与消息终态走消息状态。
 */
const NON_ROW_EVENT_TYPES = new Set<string>([
  StreamTaskEventType.AgentRouted,
  StreamTaskEventType.AgentLoopStart,
  StreamTaskEventType.StrategySelected,
  StreamTaskEventType.SkillSelected,
  StreamTaskEventType.FlowRunStarted,
  StreamTaskEventType.FlowRunResumed,
  StreamTaskEventType.TaskCreated,
  StreamTaskEventType.TaskStarted,
  StreamTaskEventType.TaskCompleted,
  StreamTaskEventType.TaskCanceled,
  StreamTaskEventType.TaskExpired,
  StreamTaskEventType.TaskError,
  StreamTaskEventType.ConversationTitleUpdated,
  StreamTaskEventType.MessageDone,
  StreamTaskEventType.OrderCreated,
  StreamTaskEventType.ApprovalRequired,
  StreamTaskEventType.ApprovalResolved,
  StreamTaskEventType.PlanReviewRequired,
  StreamTaskEventType.PlanReviewResolved,
  StreamTaskEventType.FlowWaitingHuman,
]);

/**
 * FlowRunStarted 落入历史 trace 的固定标题（后端 conversation-trace.mapper 写入）
 * @description 它代表「流程运行开始」这一骨架事件而非执行节点，摘要含流程版本 id
 * 等内部信息，不作为执行轨迹行展示。实时流按事件类型过滤，历史只能按此标题过滤。
 */
const FLOW_RUN_TRACE_TITLE = "开始执行流程";

/**
 * 判断是否为一个「执行步骤」事件（工具调用 / Flow 节点 / 工作流步骤）
 * @description 实时流与历史 trace 共用同一判定：实时事件按 StreamTaskEventType 过滤，
 * 历史项按 traceStage（tool/workflow）过滤——两侧形状不同但 stage 已归一。
 */
function isStepEvent(event: MessageStreamEventFeedback) {
  if (NON_ROW_EVENT_TYPES.has(event.type)) {
    return false;
  }
  if (event.title === FLOW_RUN_TRACE_TITLE) {
    return false;
  }
  return event.stage === "tool" || event.stage === "workflow";
}

/**
 * 把反馈事件流整理成 Codex 风格执行轨迹行
 * @param events 本轮已接收的全部反馈事件（已按生命周期折叠）
 * @param streaming 是否仍在流式进行中（决定进行中行的 ● 呼吸态）
 * @returns 返回按顺序的步骤行；空数组代表直答（无工具、无多步编排）
 */
export function buildStreamTraceRows(
  events: MessageStreamEventFeedback[],
  streaming: boolean,
): StreamTraceRow[] {
  return events.filter(isStepEvent).map((event) => ({
    key: event.id,
    status: rowStatus(event, streaming),
    name: readRowName(event),
    summary: readRowSummary(event),
    durationMs: event.durationMs ?? undefined,
    detail: readRowDetail(event),
  }));
}

function rowStatus(
  event: MessageStreamEventFeedback,
  streaming: boolean,
): StreamTraceRow["status"] {
  if (event.tone === "error") {
    return "fail";
  }
  if (event.tone === "success") {
    return "done";
  }
  // info 进行中：仅当仍在流式时才呼吸 ●，历史回显一律视为已结束
  return streaming ? "run" : "done";
}

function readRowName(event: MessageStreamEventFeedback) {
  return event.toolName || event.title;
}

function readRowSummary(event: MessageStreamEventFeedback) {
  // 摘要优先用后端给的人话总结；其次 detail（已滤掉策略名等内部术语）
  return event.toolSummary || event.detail;
}

function readRowDetail(event: MessageStreamEventFeedback) {
  const parts: string[] = [];
  if (event.inputSummary) {
    parts.push(`入参 ${formatSummaryObject(event.inputSummary)}`);
  }
  if (event.outputSummary) {
    parts.push(`出参 ${formatSummaryObject(event.outputSummary)}`);
  }
  return parts.length ? parts.join("\n") : undefined;
}

function formatSummaryObject(value: Record<string, unknown>) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 行尾耗时文案（tabular-nums 展示） */
export function formatTraceRowDuration(durationMs?: number | null) {
  if (!durationMs || durationMs <= 0) {
    return undefined;
  }

  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  return `${durationMs}ms`;
}

/**
 * 生命周期终态事件（done/completed/failed）
 * @description 这些事件与开始事件折叠为同一行，但自身只携带结果信息（摘要/耗时/错误），
 * 标题是通用文案（如「流程节点已完成」）——合并时不能让它盖掉开始事件写入的具体节点名。
 */
const LIFECYCLE_TERMINAL_TYPES = new Set<string>([
  StreamTaskEventType.ToolCallDone,
  StreamTaskEventType.ToolCallError,
  StreamTaskEventType.ModelCallDone,
  StreamTaskEventType.WorkflowStepDone,
  StreamTaskEventType.FlowNodeCompleted,
  StreamTaskEventType.FlowNodeFailed,
]);

/**
 * 合并同一行的生命周期事件（start → done/failed）
 * @description 终态事件回写状态/耗时/摘要，但标题保留开始事件的具体名称
 * （Flow 节点标题只在 started 载荷里，completed/failed 不带或带通用文案）。
 */
export function mergeStreamFeedbackEvent(
  prev: MessageStreamEventFeedback,
  next: MessageStreamEventFeedback,
): MessageStreamEventFeedback {
  const merged = { ...prev, ...next };
  if (LIFECYCLE_TERMINAL_TYPES.has(next.type) && prev.title) {
    merged.title = prev.title;
  }
  return merged;
}

function traceStageFromTraceItem(
  traceItem: MessageTraceItem,
): MessageTraceStage {
  if (traceItem.status === "ERROR" || traceItem.type === "ERROR") {
    return "error";
  }
  if (traceItem.type === "MODEL_CALL") {
    return "model";
  }
  if (traceItem.type === "TOOL_CALL") {
    return "tool";
  }
  if (traceItem.type === "APPROVAL") {
    return "approval";
  }
  if (traceItem.type === "MESSAGE_FINALIZE") {
    return "output";
  }
  if (
    traceItem.type === "AGENT_ROUTING" ||
    traceItem.type === "STRATEGY_DECISION" ||
    traceItem.type === "SKILL_SELECTION"
  ) {
    return "context";
  }
  return "workflow";
}

function traceStageFromEvent(type: StreamTaskEventType): MessageTraceStage {
  if (
    type === StreamTaskEventType.TaskError ||
    type === StreamTaskEventType.ToolCallError
  ) {
    return "error";
  }
  if (
    type === StreamTaskEventType.ModelCallStart ||
    type === StreamTaskEventType.ModelCallDone
  ) {
    return "model";
  }
  if (
    type === StreamTaskEventType.ToolCallStart ||
    type === StreamTaskEventType.ToolCallDelta ||
    type === StreamTaskEventType.ToolCallDone
  ) {
    return "tool";
  }
  if (
    type === StreamTaskEventType.ApprovalRequired ||
    type === StreamTaskEventType.ApprovalResolved ||
    type === StreamTaskEventType.PlanReviewRequired ||
    type === StreamTaskEventType.PlanReviewResolved
  ) {
    return "approval";
  }
  if (
    type === StreamTaskEventType.MessageDone ||
    type === StreamTaskEventType.TaskCompleted
  ) {
    return "output";
  }
  if (
    type === StreamTaskEventType.AgentRouted ||
    type === StreamTaskEventType.StrategySelected ||
    type === StreamTaskEventType.SkillSelected
  ) {
    return "context";
  }
  return "workflow";
}
