// 中文文案与载荷契约来自前后端共享包（唯一事实源）
import {
  STREAM_TASK_EVENT_LABELS as EVENT_LABELS,
  getAgentStrategyLabel,
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
  const title = publicStatus || EVENT_LABELS[type] || "任务状态更新";
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

  return {
    id: resolveFeedbackId(event, type, payload),
    type: event.type,
    title,
    detail,
    tone: EVENT_TONES[type] || "info",
    display: isTextDisplayEvent(type) ? "text" : "panel",
    stage: traceStageFromEvent(type),
    toolSummary,
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
    detail: joinParts([
      traceItem.summary || undefined,
      formatTraceDuration(traceItem.durationMs),
    ]),
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
      return joinParts([
        payload.mode && `策略 ${getAgentStrategyLabel(payload.mode)}`,
        payload.reason,
      ]);
    }
    case StreamTaskEventType.SkillSelected: {
      const payload = payloadOf(raw, StreamTaskEventType.SkillSelected);
      return joinParts([
        payload.skill && `能力 ${payload.skill}`,
        payload.strategy && `策略 ${getAgentStrategyLabel(payload.strategy)}`,
      ]);
    }
    case StreamTaskEventType.WorkflowStepStart:
    case StreamTaskEventType.WorkflowStepDone: {
      const payload = payloadOf(raw, StreamTaskEventType.WorkflowStepDone);
      return joinParts([
        payload.step && `步骤 ${payload.title ?? payload.step}`,
        payload.strategy && getAgentStrategyLabel(payload.strategy),
      ]);
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

function formatTraceDuration(durationMs?: number | null) {
  if (!durationMs || durationMs <= 0) {
    return undefined;
  }

  if (durationMs >= 1000) {
    return `耗时 ${(durationMs / 1000).toFixed(1)}s`;
  }

  return `耗时 ${durationMs}ms`;
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
