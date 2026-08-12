import { useMemo } from "react";
import { ScrollView, View, Text } from "@tarojs/components";
import type {
  ApprovalDecision,
  PlanReviewDecision,
} from "@litter-bear/types/protocol";
import ChatBubble from "../ChatBubble";
import { useAutoScrollToBottom } from "../../hooks/useAutoScrollToBottom";
import { appIconTileClass } from "../../utils/style";

interface MessageListProps {
  messages: Message[];
  isStreaming?: boolean;
  /** 当前会话 id：切换会话时首屏重新无动画直达底部 */
  conversationId?: string;
  onToggleStreamFeedback?: (messageId: string) => void;
  onApproval?: (messageId: string, decision: ApprovalDecision) => void;
  onPlanReview?: (messageId: string, decision: PlanReviewDecision) => void;
}

const sampleQuestions = [
  "帮我把今天的待办排个优先级",
  "把这段话改得更自然一点",
  "给我 5 个晚餐灵感",
  "解释一个我不懂的概念",
];

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
        className="box-border h-full overflow-hidden px-[0rem] pb-[1.25rem] pt-[1.125rem]"
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
          <View className="box-border flex min-h-full flex-col px-[1rem] pb-[2rem] pt-[2rem]">
            <View className="mb-[1.25rem] flex items-center gap-[0.75rem]">
              <View
                className={`${appIconTileClass} h-[2.75rem] w-[2.75rem] shrink-0 text-[1.375rem]`}
              >
                <Text className="leading-none">🐻</Text>
              </View>
              <View className="min-w-0 flex-1">
                <Text className="block text-[1.25rem] font-bold leading-[1.25] text-[var(--lb-text-primary)]">
                  新对话
                </Text>
                <Text className="mt-[0.25rem] block text-[0.8125rem] leading-[1.4] text-[var(--lb-text-muted)]">
                  Litter Bear 已准备好
                </Text>
              </View>
            </View>
            <Text className="block max-w-[19rem] text-[1.125rem] leading-[1.65] text-[var(--lb-text-secondary)]">
              告诉我你正在处理什么，我会帮你梳理问题并推进下一步。
            </Text>
            <View className="mt-[1.75rem] w-full">
              <Text className="mb-[0.625rem] block text-left text-[0.8125rem] font-semibold leading-none text-[var(--lb-text-muted)]">
                可以这样开始
              </Text>
              <View className="flex flex-col gap-[0.5rem]">
                {sampleQuestions.map((question) => (
                  <View
                    key={question}
                    className="rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[0.875rem] py-[0.75rem] text-left active:bg-[var(--lb-surface-hover)]"
                  >
                    <Text className="block text-[0.875rem] leading-[1.45] text-[var(--lb-text-primary)]">
                      {question}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
        ) : (
          <>
            {messages.map((msg) => (
              <ChatBubble
                key={msg.id}
                message={msg}
                onToggleStreamFeedback={onToggleStreamFeedback}
                onApproval={onApproval}
                onPlanReview={onPlanReview}
              />
            ))}
          </>
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
          <Text className="at-icon at-icon-chevron-down text-[0.9375rem] leading-none" />
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
