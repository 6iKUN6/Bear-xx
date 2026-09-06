import { useMemo } from "react";
import { ScrollView, View, Text } from "@tarojs/components";
import type {
  ApprovalDecision,
  PlanReviewDecision,
} from "@litter-bear/types/protocol";
import ChatBubble from "../ChatBubble";
import AppIcon from "../AppIcon";
import { useAutoScrollToBottom } from "../../hooks/useAutoScrollToBottom";

interface MessageListProps {
  messages: Message[];
  isStreaming?: boolean;
  /** 当前会话 id：切换会话时首屏重新无动画直达底部 */
  conversationId?: string;
  onToggleStreamFeedback?: (messageId: string) => void;
  onApproval?: (messageId: string, decision: ApprovalDecision) => void;
  onPlanReview?: (messageId: string, decision: PlanReviewDecision) => void;
}

export default function MessageList({
  messages,
  isStreaming = false,
  conversationId,
  onToggleStreamFeedback,
  onApproval,
  onPlanReview,
}: MessageListProps) {
  const scrollSignal = useMemo(
    () => messages.map(getMessageScrollSignal).join("|"),
    [messages],
  );
  const {
    bottomAnchorAId,
    bottomAnchorBId,
    containerId,
    handleScroll,
    handleScrollToLower,
    handleUserScrollEnd,
    handleUserScrollMove,
    handleUserScrollStart,
    restoreAutoScroll,
    scrollIntoView,
    scrollWithAnimation,
    showScrollToBottom,
  } = useAutoScrollToBottom({
    enabled: messages.length > 0,
    isStreaming,
    scrollSignal,
    resetKey: conversationId,
  });

  return (
    <View className="relative min-h-0 flex-1">
      <ScrollView
        id={containerId}
        className="box-border h-full overflow-hidden px-[0.875rem] pb-[1.25rem] pt-[1rem]"
        lowerThreshold={96}
        scrollIntoView={scrollIntoView}
        scrollY
        scrollWithAnimation={scrollWithAnimation}
        onScroll={handleScroll}
        onScrollToLower={handleScrollToLower}
        onTouchStart={handleUserScrollStart}
        onTouchMove={handleUserScrollMove}
        onTouchEnd={handleUserScrollEnd}
        onTouchCancel={handleUserScrollEnd}
        onDragStart={handleUserScrollStart}
        onDragEnd={handleUserScrollEnd}
      >
        {messages.length === 0 ? (
          // 独立 chat 页（深链进空会话）的兜底空态：新对话页的完整空态由
          // NewChatPanel 承载，这里只留一句指引，不放假入口。
          <View className="box-border flex min-h-full flex-col pb-[2rem] pt-[2.5rem]">
            <Text className="block text-[1.25rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
              新对话
            </Text>
            <Text className="mt-[0.5rem] block max-w-[19rem] text-[0.9375rem] leading-[1.6] text-[var(--lb-text-secondary)]">
              直接输入你的问题或想法，开始这段对话。
            </Text>
          </View>
        ) : (
          <View className="flex flex-col gap-[1.125rem]">
            {messages.map((msg) => (
              <ChatBubble
                key={msg.id}
                message={msg}
                onToggleStreamFeedback={onToggleStreamFeedback}
                onApproval={onApproval}
                onPlanReview={onPlanReview}
              />
            ))}
          </View>
        )}
        <View className="h-[0.625rem]" />
        <View id={bottomAnchorAId} className="h-0 w-full" />
        <View id={bottomAnchorBId} className="h-0 w-full" />
      </ScrollView>

      {/* 回到底部 */}
      <View
        className="pointer-events-none absolute bottom-[0.875rem] left-0 right-0 z-20 flex justify-center transition-opacity"
        style={{
          opacity: showScrollToBottom ? 1 : 0,
        }}
      >
        <View
          className="pointer-events-auto flex items-center gap-[0.375rem] rounded-full border border-[var(--lb-line-strong)] bg-[var(--lb-surface)] px-[0.75rem] py-[0.5rem] text-[0.8125rem] font-semibold leading-none text-[var(--lb-accent-ink)] shadow-[var(--lb-shadow-card)] active:scale-95"
          onClick={() => {
            showScrollToBottom && restoreAutoScroll();
          }}
        >
          <AppIcon name="chevronDown" className="h-[0.9375rem] w-[0.9375rem]" />
          <Text className="leading-none">回到底部</Text>
        </View>
      </View>
    </View>
  );
}

function getMessageScrollSignal(message: Message) {
  const currentEventId =
    message.streamFeedback?.current?.id || message.currentStreamEvent?.id || "";
  const eventCount = message.streamFeedback?.events.length || 0;
  const expanded = message.streamFeedback?.expanded ? "1" : "0";

  return [
    message.id,
    message.status,
    message.content.length,
    currentEventId,
    eventCount,
    expanded,
  ].join(":");
}
