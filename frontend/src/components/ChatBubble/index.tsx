import { memo } from "react";
import { View, Text } from "@tarojs/components";
import MarkdownContent from "../MarkdownContent";
import { appIconTileClass } from "../../utils/style";

interface ChatBubbleProps {
  message: Message;
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === "user";
  const currentStreamEvent = message.currentStreamEvent;

  return (
    <View
      className={`mb-[1.25rem] flex px-[1rem] ${isUser ? "justify-end" : "justify-start"}`}
    >
      <View
        className={`flex max-w-[84%] flex-col ${isUser ? "items-end" : "items-start"}`}
      >
        {!isUser && (
          <View
            className={`${appIconTileClass} mb-[0.5rem] h-[2.375rem] w-[2.375rem] rounded-[0.75rem] text-[1.125rem] shadow-[0_0.75rem_1.5rem_rgba(236,72,153,0.22)]`}
          >
            <Text className='leading-none'>🐻</Text>
          </View>
        )}

        {!isUser && currentStreamEvent && (
          <StreamFeedbackItem event={currentStreamEvent} />
        )}

        <View
          className={`box-border min-w-0 overflow-hidden px-[1.125rem] py-[0.875rem] text-[1rem] leading-[1.7] shadow-[0_0.625rem_1.5rem_rgba(124,58,237,0.06)] ${isUser ? "rounded-[1.125rem_1.125rem_0.375rem_1.125rem] bg-gradient-to-r from-[#9333ea] via-[#ec4899] to-[#6366f1] text-white" : "rounded-[1.125rem_1.125rem_1.125rem_0.375rem] border border-[rgba(196,181,253,0.2)] bg-white text-[var(--lb-text-primary)]"}`}
        >
          <MarkdownContent
            content={message.content}
            emptyText={
              message.status === "streaming" ? "正在组织回复..." : undefined
            }
            className={isUser ? "text-white" : "text-[var(--lb-text-primary)]"}
          />
        </View>

        <Text
          className={`mt-[0.5rem] px-[0.375rem] text-[0.75rem] leading-none text-[var(--lb-text-muted)] ${isUser ? "text-right" : "text-left"}`}
        >
          {formatTime(message.createdAt)}
        </Text>

        {message.status === "error" && (
          <Text className='mt-[0.375rem] block px-[0.375rem] text-[0.75rem] text-[var(--lb-danger)]'>
            发送失败
          </Text>
        )}
      </View>
    </View>
  );
}

function StreamFeedbackItem({ event }: { event: MessageStreamEventFeedback }) {
  if (event.display === "text") {
    return (
      <Text className='mb-[0.5rem] block px-[0.375rem] text-[0.75rem] leading-[1.4] text-[#16a34a]'>
        {event.title}
        {event.detail ? ` · ${event.detail}` : ""}
      </Text>
    );
  }

  const toneClass =
    event.tone === "warning"
      ? "border-[rgba(245,158,11,0.2)] bg-[rgba(255,251,235,0.92)] text-[#92400e]"
      : event.tone === "error"
        ? "border-[rgba(239,68,68,0.2)] bg-[rgba(254,242,242,0.94)] text-[#991b1b]"
        : "border-[rgba(124,58,237,0.14)] bg-white/80 text-[var(--lb-text-secondary)]";

  const dotClass =
    event.tone === "warning"
      ? "bg-[#f59e0b]"
      : event.tone === "error"
        ? "bg-[#ef4444]"
        : "bg-[var(--lb-grad-a)]";

  return (
    <View
      className={`mb-[0.5rem] box-border flex w-full items-start gap-[0.5rem] rounded-[0.875rem] border px-[0.75rem] py-[0.625rem] shadow-[0_0.375rem_1rem_rgba(124,58,237,0.04)] ${toneClass}`}
    >
      <View
        className={`mt-[0.3125rem] h-[0.375rem] w-[0.375rem] shrink-0 rounded-full ${dotClass}`}
      />
      <View className='min-w-0 flex-1'>
        <Text className='block text-[0.8125rem] font-semibold leading-[1.35]'>
          {event.title}
        </Text>
        {event.detail && (
          <Text className='mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.35] opacity-75'>
            {event.detail}
          </Text>
        )}
      </View>
    </View>
  );
}

export default memo(ChatBubble);
