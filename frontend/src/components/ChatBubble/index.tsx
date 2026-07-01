import { memo } from "react";
import type { ReactNode } from "react";
import { View, Text } from "@tarojs/components";
import StreamFeedback from "../StreamFeedback";
import StreamingMarkdownContent from "../StreamingMarkdownContent";
import { appIconTileClass } from "../../utils/style";

interface ChatBubbleProps {
  message: Message;
  renderExtra?: (slotProps: ChatBubbleExtraSlotProps) => ReactNode;
  onToggleStreamFeedback?: (messageId: string) => void;
}

export interface ChatBubbleExtraSlotProps {
  message: Message;
  isUser: boolean;
  isStreaming: boolean;
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

function ChatBubble({
  message,
  renderExtra,
  onToggleStreamFeedback,
}: ChatBubbleProps) {
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const extra = renderExtra ? (
    renderExtra({ message, isUser, isStreaming })
  ) : (
    <DefaultBubbleExtraSlot
      message={message}
      onToggleStreamFeedback={onToggleStreamFeedback}
    />
  );

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

        {!isUser && extra}

        <View
          className={`box-border min-w-0 overflow-hidden text-[1rem] leading-[1.7] ${isUser ? "rounded-[1.125rem_1.125rem_0.375rem_1.125rem] bg-gradient-to-r from-[#9333ea] via-[#ec4899] to-[#6366f1] px-[1.125rem] py-[0.875rem] text-white shadow-[0_0.625rem_1.5rem_rgba(124,58,237,0.06)]" : "px-[0.125rem] py-[0.125rem] text-[var(--lb-text-primary)]"}`}
        >
          <StreamingMarkdownContent
            content={message.content}
            emptyText={
              message.status === "streaming" ? "正在组织回复..." : undefined
            }
            className={isUser ? "text-white" : "text-[var(--lb-text-primary)]"}
            streaming={!isUser && isStreaming}
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

function DefaultBubbleExtraSlot({
  message,
  onToggleStreamFeedback,
}: {
  message: Message;
  onToggleStreamFeedback?: (messageId: string) => void;
}) {
  return (
    <StreamFeedback
      feedback={message.streamFeedback}
      fallbackCurrent={message.currentStreamEvent}
      streaming={message.status === "streaming"}
      onToggle={() => onToggleStreamFeedback?.(message.id)}
    />
  );
}

export default memo(ChatBubble);
