import { memo } from "react";
import type { ReactNode } from "react";
import { Image, View, Text } from "@tarojs/components";
import StreamFeedback from "../StreamFeedback";
import StreamingMarkdownContent from "../StreamingMarkdownContent";
import { useUserStore } from "../../store/userStore";
import {
  appGradientSurfaceClass,
  appIconTileClass,
  appLoadingDotClass,
} from "../../utils/style";
import "./index.scss";

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

function readInitial(name?: string | null) {
  const trimmed = name?.trim();

  if (!trimmed) {
    return "用";
  }

  return trimmed.slice(0, 1).toUpperCase();
}

function ChatBubble({
  message,
  renderExtra,
  onToggleStreamFeedback,
}: ChatBubbleProps) {
  const userInfo = useUserStore((state) => state.userInfo);
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const displayName = isUser ? userInfo?.nickname || "用户" : "Litter Bear";
  const extra = renderExtra ? (
    renderExtra({ message, isUser, isStreaming })
  ) : (
    <DefaultBubbleExtraSlot
      message={message}
      onToggleStreamFeedback={onToggleStreamFeedback}
    />
  );

  return (
    <View className="mb-[1.25rem] flex w-full min-w-0 items-start gap-[0.75rem] px-[1rem] box-border">
      <BubbleAvatar
        isUser={isUser}
        avatarUrl={userInfo?.avatarUrl}
        name={displayName}
      />

      <View className="flex min-w-0 flex-1 flex-col items-stretch">
        <View className="flex min-w-0 items-center gap-[0.5rem]">
          <Text className="block min-w-0 max-w-full flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]">
            {displayName}
          </Text>
          <Text className="shrink-0 text-[0.75rem] leading-none text-[var(--lb-text-muted)]">
            {formatTime(message.createdAt)}
          </Text>
        </View>

        {!isUser && <View className="mt-[0.5rem] min-w-0">{extra}</View>}

        <View className={bubbleBodyClass(isUser)}>
          <StreamingMarkdownContent
            content={message.content}
            emptyText={
              message.status === "streaming" ? "正在组织回复..." : undefined
            }
            className={isUser ? "text-white" : "text-[var(--lb-text-primary)]"}
            streaming={!isUser && isStreaming}
          />
        </View>

        {!isUser && <MessageMetricsMeta message={message} />}

        {message.status === "error" && (
          <Text className="mt-[0.375rem] block px-[0.375rem] text-[0.75rem] text-[var(--lb-danger)]">
            发送失败
          </Text>
        )}
      </View>
    </View>
  );
}

function BubbleAvatar({
  isUser,
  avatarUrl,
  name,
}: {
  isUser: boolean;
  avatarUrl?: string;
  name: string;
}) {
  if (isUser && avatarUrl) {
    return (
      <Image
        className="h-[2.5rem] w-[2.5rem] shrink-0 rounded-[0.875rem] border border-white/80 box-border shadow-[0_0.75rem_1.5rem_rgba(124,58,237,0.12)]"
        src={avatarUrl}
        mode="aspectFill"
      />
    );
  }

  if (isUser) {
    return (
      <View
        className={`${appGradientSurfaceClass} flex h-[2.5rem] w-[2.5rem] shrink-0 items-center justify-center rounded-[0.875rem] text-[1rem] font-bold shadow-[0_0.75rem_1.5rem_rgba(236,72,153,0.24)]`}
      >
        <Text className="leading-none text-white">{readInitial(name)}</Text>
      </View>
    );
  }

  return (
    <View
      className={`${appIconTileClass} h-[2.5rem] w-[2.5rem] shrink-0 rounded-[0.875rem] text-[1.125rem] shadow-[0_0.75rem_1.5rem_rgba(236,72,153,0.2)]`}
    >
      <Text className="leading-none">🐻</Text>
    </View>
  );
}

function bubbleBodyClass(isUser: boolean) {
  const baseClass =
    "mt-[0.5rem] box-border min-w-0 overflow-hidden text-[1rem] leading-[1.7]";

  if (isUser) {
    return `${baseClass} rounded-[1.125rem_1.125rem_1.125rem_0.375rem] bg-gradient-to-r from-[#9333ea] via-[#ec4899] to-[#6366f1] px-[1.125rem] py-[0.875rem] text-white shadow-[0_0.625rem_1.5rem_rgba(124,58,237,0.06)]`;
  }

  return `${baseClass} px-[0.125rem] py-[0.125rem] text-[var(--lb-text-primary)]`;
}

function MessageMetricsMeta({ message }: { message: Message }) {
  const metrics = readMessageMetrics(message);
  const tokenUsage = metrics?.tokenUsage;
  const totalTokens = tokenUsage?.totalTokens;
  const cachedTokens =
    tokenUsage?.cachedInputTokens ?? metrics?.cache?.cachedInputTokens;
  const cacheHit =
    Boolean(metrics?.cache?.memorySummaryHit) ||
    Boolean(metrics?.cache?.providerPromptCacheHit) ||
    Boolean(metrics?.cache?.contextCacheHit) ||
    Boolean(cachedTokens && cachedTokens > 0);
  const durationMs = metrics?.durationMs;

  if (!totalTokens && !cacheHit && !durationMs) {
    return null;
  }

  return (
    <View className="mt-[0.375rem] flex min-w-0 flex-wrap items-center gap-x-[0.625rem] gap-y-[0.25rem] px-[0.125rem] text-[0.6875rem] leading-[1.4] text-[var(--lb-text-muted)]">
      {totalTokens ? (
        <MetricPill
          icon="T"
          text={`${formatCompactNumber(totalTokens)} tokens${tokenUsage?.estimated ? " 估算" : ""}`}
        />
      ) : null}

      {cacheHit ? (
        <MetricPill
          icon="C"
          text={
            cachedTokens
              ? `缓存命中 ${formatCompactNumber(cachedTokens)}`
              : "缓存命中"
          }
        />
      ) : null}

      {durationMs ? (
        <MetricPill icon="S" text={`${formatDuration(durationMs)}`} />
      ) : null}
    </View>
  );
}

function MetricPill({ icon, text }: { icon: string; text: string }) {
  return (
    <View className="flex min-w-0 items-center gap-[0.25rem]">
      <Text className="flex h-[0.875rem] w-[0.875rem] shrink-0 items-center justify-center rounded-full bg-[rgba(107,114,128,0.12)] text-[0.5625rem] font-semibold leading-none text-[var(--lb-text-muted)]">
        {icon}
      </Text>
      <Text className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
        {text}
      </Text>
    </View>
  );
}

function readMessageMetrics(message: Message): MessageRunMetrics | null {
  if (message.metrics) {
    return message.metrics;
  }

  const finalizeTrace = message.trace
    ?.slice()
    .reverse()
    .find((item) => item.type === "MESSAGE_FINALIZE" && item.metrics);

  return finalizeTrace?.metrics ?? null;
}

function formatCompactNumber(value: number) {
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)}w`;
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }

  return String(value);
}

function formatDuration(durationMs: number) {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  return `${durationMs}ms`;
}

function DefaultBubbleExtraSlot({
  message,
  onToggleStreamFeedback,
}: {
  message: Message;
  onToggleStreamFeedback?: (messageId: string) => void;
}) {
  const isWaitingForFirstEvent =
    message.status === "streaming" &&
    !message.streamFeedback?.current &&
    !message.currentStreamEvent;

  if (isWaitingForFirstEvent) {
    return <WaitingStreamFeedback />;
  }

  return (
    <StreamFeedback
      feedback={message.streamFeedback}
      fallbackCurrent={message.currentStreamEvent}
      streaming={message.status === "streaming"}
      onToggle={() => onToggleStreamFeedback?.(message.id)}
    />
  );
}

function WaitingStreamFeedback() {
  return (
    <View className="chat-bubble-waiting-feedback">
      <View className="chat-bubble-waiting-shimmer" />
      <View className="relative z-[2] flex items-center gap-[0.375rem]">
        <View className={`${appLoadingDotClass} bg-[var(--lb-grad-a)]`} />
        <View
          className={`${appLoadingDotClass} bg-[var(--lb-grad-b)] [animation-delay:120ms]`}
        />
        <View
          className={`${appLoadingDotClass} bg-[var(--lb-grad-c)] [animation-delay:240ms]`}
        />
      </View>
      <Text className="relative z-[2] ml-[0.25rem] min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] font-semibold leading-[1.35] text-[var(--lb-text-secondary)]">
        正在连接对话服务
      </Text>
    </View>
  );
}

export default memo(ChatBubble);
