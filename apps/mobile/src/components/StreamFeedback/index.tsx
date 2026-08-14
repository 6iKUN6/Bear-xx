import { memo } from "react";
import { Text, View } from "@tarojs/components";
import { formatStreamFeedbackStatus } from "../../utils/streamFeedback";
import "./index.scss";

interface StreamFeedbackProps {
  feedback?: MessageStreamFeedbackState;
  fallbackCurrent?: MessageStreamEventFeedback;
  streaming?: boolean;
  onToggle?: () => void;
}

function StreamFeedback({
  feedback,
  fallbackCurrent,
  streaming = false,
  onToggle,
}: StreamFeedbackProps) {
  const normalizedFeedback = normalizeFeedback(feedback, fallbackCurrent);
  const current = normalizedFeedback.current;

  if (!current) {
    return null;
  }

  const events = normalizedFeedback.events;
  const expanded = normalizedFeedback.expanded;

  return (
    <View className="mb-[0.625rem] w-full max-w-full">
      <View className="stream-feedback-trigger" onClick={onToggle}>
        <CurrentStatus
          event={current}
          events={events}
          streaming={streaming}
        />
      </View>

      {expanded && (
        <View className="stream-feedback-history-list mt-[0.5rem] flex flex-col gap-[0.25rem]">
          {events.map((event) => (
            <HistoryItem
              key={event.id}
              event={event}
              active={event.id === current.id}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function CurrentStatus({
  event,
  events,
  streaming,
}: {
  event: MessageStreamEventFeedback;
  events: MessageStreamEventFeedback[];
  streaming: boolean;
}) {
  const text = formatStreamFeedbackStatus(event, events);

  return (
    <Text
      className={`stream-feedback-current-text ${streaming ? "stream-feedback-current-text-live" : ""}`}
    >
      {text}
    </Text>
  );
}

function HistoryItem({
  event,
  active,
}: {
  event: MessageStreamEventFeedback;
  active: boolean;
}) {
  return (
    <View
      className={`stream-feedback-history-item ${toneClass(event.tone)} ${active ? "stream-feedback-history-item-active" : ""}`}
    >
      <View className="min-w-0 flex-1">
        <View className="flex min-w-0 items-center gap-[0.375rem]">
          <Text className="stream-feedback-stage">
            {traceStageLabel(event.stage)}
          </Text>
          <Text className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] font-semibold leading-[1.35]">
            {event.title}
          </Text>
        </View>
        {eventDetail(event) && (
          <Text className="mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] leading-[1.35] opacity-70">
            {eventDetail(event)}
          </Text>
        )}
      </View>
    </View>
  );
}

function normalizeFeedback(
  feedback?: MessageStreamFeedbackState,
  fallbackCurrent?: MessageStreamEventFeedback,
): MessageStreamFeedbackState {
  if (feedback) {
    return feedback;
  }

  return {
    current: fallbackCurrent,
    events: fallbackCurrent ? [fallbackCurrent] : [],
    expanded: false,
  };
}

function toneClass(tone: MessageStreamEventTone) {
  if (tone === "success") {
    return "stream-feedback-tone-success";
  }

  if (tone === "warning") {
    return "stream-feedback-tone-warning";
  }

  if (tone === "error") {
    return "stream-feedback-tone-error";
  }

  return "stream-feedback-tone-info";
}

function traceStageLabel(stage?: MessageTraceStage) {
  switch (stage) {
    case "context":
      return "上下文";
    case "model":
      return "模型";
    case "tool":
      return "工具";
    case "approval":
      return "确认";
    case "output":
      return "回复";
    case "error":
      return "异常";
    default:
      return "流程";
  }
}

function eventDetail(event: MessageStreamEventFeedback) {
  const provenance = [
    event.toolName ? `工具 ${event.toolName}` : undefined,
    event.inputSummary ? "已记录输入" : undefined,
    event.outputSummary ? "已记录输出" : undefined,
  ].filter(Boolean);
  return [event.detail, ...provenance].filter(Boolean).join(" · ");
}

export default memo(StreamFeedback);
