import { memo } from "react";
import { Text, View } from "@tarojs/components";
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

  // 指派、收尾这类一句话信息不套卡片：卡片带状态点和展开箭头，
  // 会让它们看起来比实际重要，也和气泡上方的灰字提示风格割裂。
  if (current.display === "text") {
    return (
      <View className='mb-[0.625rem] w-full max-w-full'>
        <Text className='block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.35] text-[var(--lb-text-muted)]'>
          {current.detail ? `${current.title} · ${current.detail}` : current.title}
        </Text>
      </View>
    );
  }

  return (
    <View className='mb-[0.625rem] w-full max-w-full'>
      <View
        className={`stream-feedback-shell ${toneClass(current.tone)} ${expanded ? "stream-feedback-shell-expanded" : ""}`}
        onClick={onToggle}
      >
        <View className='stream-feedback-dot-wrap'>
          <View
            className={`stream-feedback-dot ${streaming ? "stream-feedback-dot-live" : ""}`}
          />
        </View>
        <View className='min-w-0 flex-1 overflow-hidden'>
          <CurrentStatus event={current} streaming={streaming} />
        </View>
        <Text
          className={`at-icon at-icon-chevron-down stream-feedback-chevron ${expanded ? "stream-feedback-chevron-expanded" : ""}`}
        />
      </View>

      {expanded && (
        <View className='mt-[0.5rem] flex flex-col gap-[0.375rem]'>
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
  streaming,
}: {
  event: MessageStreamEventFeedback;
  streaming: boolean;
}) {
  const text = event.detail ? `${event.title} · ${event.detail}` : event.title;

  return (
    <View
      className={`stream-feedback-current ${streaming ? "stream-feedback-current-live" : ""}`}
    >
      {streaming && (
        <View className='stream-feedback-skeleton' aria-hidden>
          <View className='stream-feedback-skeleton-flow' />
        </View>
      )}
      <Text className='stream-feedback-current-text'>{text}</Text>
      <View className='stream-feedback-current-fade' aria-hidden />
    </View>
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
      <View className='mt-[0.3125rem] h-[0.375rem] w-[0.375rem] shrink-0 rounded-full bg-current opacity-70' />
      <View className='min-w-0 flex-1'>
        <Text className='block text-[0.75rem] font-semibold leading-[1.35]'>
          {event.title}
        </Text>
        {event.detail && (
          <Text className='mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] leading-[1.35] opacity-70'>
            {event.detail}
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

export default memo(StreamFeedback);
