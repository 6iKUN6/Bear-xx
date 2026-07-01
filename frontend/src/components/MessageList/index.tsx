import { useMemo } from "react";
import { ScrollView, View, Text } from "@tarojs/components";
import ChatBubble from "../ChatBubble";
import { useAutoScrollToBottom } from "../../hooks/useAutoScrollToBottom";
import {
  appGradientSurfaceWarmClass,
  appGradientTextClass,
  appIconTileClass,
} from "../../utils/style";

interface MessageListProps {
  messages: Message[];
  isStreaming?: boolean;
  onToggleStreamFeedback?: (messageId: string) => void;
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
  onToggleStreamFeedback,
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
    handleUserScrollStart,
    restoreAutoScroll,
    scrollIntoView,
    showScrollToBottom,
  } = useAutoScrollToBottom({
    enabled: messages.length > 0,
    isStreaming,
    scrollSignal,
  });

  return (
    <View className="relative min-h-0 flex-1">
      <ScrollView
        id={containerId}
        className="box-border h-full overflow-hidden px-[0rem] pb-[1.25rem] pt-[1.125rem]"
        lowerThreshold={96}
        scrollIntoView={scrollIntoView}
        scrollY
        scrollWithAnimation
        onScroll={handleScroll}
        onScrollToLower={handleScrollToLower}
        onTouchStart={handleUserScrollStart}
        onTouchMove={handleUserScrollStart}
        onTouchEnd={handleUserScrollEnd}
        onTouchCancel={handleUserScrollEnd}
        onDragStart={handleUserScrollStart}
        onDragEnd={handleUserScrollEnd}
      >
        {messages.length === 0 ? (
          <View className="box-border flex min-h-full flex-col items-center justify-center px-[1.25rem] pt-[2.5rem] text-center">
            <View className="relative mb-[1.25rem] animate-app-float">
              <View
                className={`${appIconTileClass} h-[5rem] w-[5rem] rounded-[1.5rem] text-[3rem] shadow-[0_1.25rem_3.125rem_rgba(124,58,237,0.24)]`}
              >
                <Text className="leading-none">🐻</Text>
              </View>
              <View
                className={`${appGradientSurfaceWarmClass} absolute -right-[0.25rem] -top-[0.25rem] flex h-[2rem] w-[2rem] animate-app-twinkle items-center justify-center rounded-full text-[1rem] shadow-[0_0.625rem_1.5rem_rgba(251,146,60,0.3)]`}
              >
                <Text className="leading-none">✦</Text>
              </View>
            </View>
            <Text
              className={`${appGradientTextClass} mb-[0.625rem] block text-[1.5rem] font-bold leading-[1.2]`}
            >
              嗨，我是 Litter Bear
            </Text>
            <Text className="block text-[1rem] leading-[1.7] text-[var(--lb-text-secondary)]">
              你的 AI 智能助手
            </Text>
            <Text className="mt-[0.125rem] block text-[1rem] leading-[1.7] text-[var(--lb-text-secondary)]">
              有什么可以帮到你的吗？
            </Text>
            <View className="mt-[1.375rem] w-full">
              <Text className="mb-[0.625rem] block text-left text-[0.8125rem] font-semibold leading-none text-[var(--lb-text-muted)]">
                可以这样开始
              </Text>
              <View className="flex flex-col gap-[0.5rem]">
                {sampleQuestions.map((question) => (
                  <View
                    key={question}
                    className="rounded-[1rem] border border-[rgba(196,181,253,0.24)] bg-white/80 px-[0.875rem] py-[0.75rem] text-left shadow-[0_0.375rem_1rem_rgba(124,58,237,0.04)]"
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
              />
            ))}
          </>
        )}
        <View className="h-[0.625rem]" />
        <View id={bottomAnchorAId} className="h-0 w-full" />
        <View id={bottomAnchorBId} className="h-0 w-full" />
      </ScrollView>

      {showScrollToBottom && (
        <View className="pointer-events-none absolute bottom-[0.875rem] left-0 right-0 z-20 flex justify-center">
          <View
            className="pointer-events-auto flex items-center gap-[0.375rem] rounded-full border border-[rgba(124,58,237,0.12)] bg-white/95 px-[0.75rem] py-[0.5rem] text-[0.8125rem] font-semibold leading-none text-[var(--lb-grad-a)] shadow-[0_0.625rem_1.5rem_rgba(124,58,237,0.12)] backdrop-blur-[1rem] active:scale-95"
            onClick={restoreAutoScroll}
          >
            <Text className="at-icon at-icon-chevron-down text-[0.9375rem] leading-none" />
            <Text className="leading-none">回到底部</Text>
          </View>
        </View>
      )}
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
