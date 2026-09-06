import { memo } from "react";
import type { ReactNode } from "react";
import { Image, View, Text } from "@tarojs/components";
import {
  StreamTaskEventType,
  type ApprovalDecision,
  type PlanReviewDecision,
} from "@litter-bear/types/protocol";
import StreamFeedback from "../StreamFeedback";
import ApprovalCard from "../ApprovalCard";
import AgentAvatar from "../AgentAvatar";
import McdonaldsOrderCard from "../McdonaldsOrderCard";
import PlanReviewCard from "../PlanReviewCard";
import StreamingMarkdownContent from "../StreamingMarkdownContent";
import { useUserStore } from "../../store/userStore";
import { useAgentStore } from "../../store/agentStore";
import { useChatStore } from "../../store/chatStore";
import {
  FALLBACK_AGENT_NAME,
  findAgent,
  getUnassignedAssistantNotice,
} from "../../utils/agent";
import { appLoadingDotClass } from "../../utils/style";
import "./index.scss";

interface ChatBubbleProps {
  message: Message;
  renderExtra?: (slotProps: ChatBubbleExtraSlotProps) => ReactNode;
  onToggleStreamFeedback?: (messageId: string) => void;
  onApproval?: (messageId: string, decision: ApprovalDecision) => void;
  onPlanReview?: (messageId: string, decision: PlanReviewDecision) => void;
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
  onApproval,
  onPlanReview,
}: ChatBubbleProps) {
  const userInfo = useUserStore((state) => state.userInfo);
  const agents = useAgentStore((state) => state.agents);
  const upsertMessageOrder = useChatStore((state) => state.upsertMessageOrder);
  const persistConversations = useChatStore(
    (state) => state.persistConversations,
  );
  const conversationType = useChatStore(
    (state) => state.currentConversation?.type,
  );
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  // 群聊自动路由尚未落定：尚无服务端写入的 agentId 或 agentName。
  // 必须在默认智能体解析前判断，否则 null agentId 会错误命中默认助手。
  const isAssistantWithoutExplicitIdentity =
    !isUser && !message.agentId && !message.agentName;
  const hasCreatedTask =
    message.currentStreamEvent?.type === StreamTaskEventType.TaskCreated ||
    message.streamFeedback?.events.some(
      (event) => event.type === StreamTaskEventType.TaskCreated,
    ) === true;
  const unassignedAssistantNotice = getUnassignedAssistantNotice(
    message.status,
    conversationType === "GROUP",
    !isAssistantWithoutExplicitIdentity,
    Boolean(message.routing),
    hasCreatedTask,
  );

  // 没有归属的这两种状态，头像、名字、正文全是占位，撑起一整个气泡
  // 反而像「某人已经在回答」。统一收成一行灰字。
  if (unassignedAssistantNotice) {
    return (
      <UnassignedNotice
        text={
          unassignedAssistantNotice === "routing" ? "正在指派…" : "发送失败"
        }
      />
    );
  }

  // 正常助手消息才按 id 解析；null 代表后端默认智能体，可显示其配置头像。
  const speakerAgent = !isUser
    ? findAgent(agents, message.agentId)
    : undefined;
  const displayName = isUser
    ? userInfo?.nickname || "用户"
    : message.agentName || speakerAgent?.name || FALLBACK_AGENT_NAME;
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
      className={`flex w-full min-w-0 items-start gap-[0.625rem] box-border ${
        isUser ? "flex-row-reverse" : ""
      }`}
    >
      {isUser ? (
        <BubbleAvatar avatarUrl={userInfo?.avatarUrl} name={displayName} />
      ) : (
        <AgentAvatar
          name={displayName}
          avatar={speakerAgent?.avatar}
          size='sm'
          className='h-[2.25rem] w-[2.25rem] shrink-0 rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] box-border'
        />
      )}

      <View
        className={`flex min-w-0 flex-col ${
          isUser ? "max-w-[78%] items-end" : "flex-1 items-stretch"
        }`}
      >
        <View
          className={`flex min-w-0 items-center gap-[0.5rem] ${
            isUser ? "flex-row-reverse" : ""
          }`}
        >
          <Text className='block min-w-0 max-w-full flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] font-semibold leading-[1.35] text-[var(--lb-text-secondary)]'>
            {displayName}
          </Text>
          <Text className='shrink-0 text-[0.6875rem] leading-none text-[var(--lb-text-muted)]'>
            {formatTime(message.createdAt)}
          </Text>
        </View>

        {!isUser && <View className='mt-[0.5rem] min-w-0'>{extra}</View>}

        <View className={bubbleBodyClass(isUser)}>
          <StreamingMarkdownContent
            content={message.content}
            emptyText={
              message.status === "streaming" ? "正在组织回复..." : undefined
            }
            className={isUser ? "text-[var(--lb-on-accent)]" : "text-[var(--lb-text-primary)]"}
            streaming={!isUser && isStreaming}
          />
        </View>

        {!isUser && message.orders?.length ? (
          <View className='mt-[0.75rem] flex min-w-0 flex-col gap-[0.625rem]'>
            {message.orders.map((order) => (
              <McdonaldsOrderCard
                key={order.id}
                order={order}
                onOrderChange={(next) => {
                  upsertMessageOrder(message.id, next);
                  persistConversations();
                }}
              />
            ))}
          </View>
        ) : null}

        {!isUser && message.pendingApproval && (
          <View className='mt-[0.5rem] min-w-0'>
            <ApprovalCard
              payload={message.pendingApproval}
              onDecision={(decision) => onApproval?.(message.id, decision)}
            />
          </View>
        )}

        {!isUser && message.resolvedApproval && (
          <View className='mt-[0.5rem] min-w-0'>
            <ApprovalCard
              payload={message.resolvedApproval.payload}
              resolved
              resolvedDecision={message.resolvedApproval.decision}
            />
          </View>
        )}

        {!isUser && message.pendingPlanReview && (
          <View className='mt-[0.5rem] min-w-0'>
            <PlanReviewCard
              payload={message.pendingPlanReview}
              onDecision={(decision) => onPlanReview?.(message.id, decision)}
            />
          </View>
        )}

        {message.status === "error" && (
          <Text className='mt-[0.375rem] block px-[0.375rem] text-[0.75rem] text-[var(--lb-danger)]'>
            发送失败
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * 无归属消息的单行提示
 * @description 指派未落定（进行中或失败）时代替整个气泡，避免占位头像与
 * 默认助手名让用户误以为已经有人在回答。
 */
function UnassignedNotice({ text }: { text: string }) {
  return (
    <View className='flex w-full min-w-0 items-center box-border'>
      <Text className='min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.35] text-[var(--lb-text-muted)]'>
        {text}
      </Text>
    </View>
  );
}

function BubbleAvatar({
  avatarUrl,
  name,
}: {
  avatarUrl?: string;
  name: string;
}) {
  if (avatarUrl) {
    return (
      <Image
        className='h-[2.25rem] w-[2.25rem] shrink-0 rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] box-border'
        src={avatarUrl}
        mode='aspectFill'
      />
    );
  }

  return (
    <View className='flex h-[2.25rem] w-[2.25rem] shrink-0 items-center justify-center rounded-[var(--lb-radius-md)] bg-[var(--lb-accent)]'>
      <Text className='text-[0.875rem] font-bold leading-none text-[var(--lb-on-accent)]'>
        {readInitial(name)}
      </Text>
    </View>
  );
}

function bubbleBodyClass(isUser: boolean) {
  const baseClass =
    "mt-[0.5rem] box-border min-w-0 overflow-hidden text-[0.9375rem] leading-[1.7]";

  if (isUser) {
    // 用户消息：accent 实底气泡，右下小角的不对称圆角（圆角语法：左上 右上 右下 左下）
    return `${baseClass} rounded-[var(--lb-radius-md)_var(--lb-radius-md)_var(--lb-radius-xs)_var(--lb-radius-md)] bg-[var(--lb-accent)] px-[0.875rem] py-[0.625rem] text-[var(--lb-on-accent)] shadow-[var(--lb-shadow-card)]`;
  }

  // AI 消息：直排 markdown，无气泡框
  return `${baseClass} py-[0.125rem] text-[var(--lb-text-primary)]`;
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
      metrics={readMessageMetrics(message)}
      streaming={message.status === "streaming"}
      onToggle={() => onToggleStreamFeedback?.(message.id)}
    />
  );
}

function WaitingStreamFeedback() {
  return (
    <View className='chat-bubble-waiting-feedback'>
      <View className='chat-bubble-waiting-shimmer' />
      <View className='relative z-[2] flex items-center gap-[0.375rem]'>
        <View className={`${appLoadingDotClass} bg-[var(--lb-info)]`} />
        <View
          className={`${appLoadingDotClass} bg-[var(--lb-accent)] [animation-delay:120ms]`}
        />
        <View
          className={`${appLoadingDotClass} bg-[var(--lb-success)] [animation-delay:240ms]`}
        />
      </View>
      <Text className='relative z-[2] ml-[0.25rem] min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] font-semibold leading-[1.35] text-[var(--lb-text-secondary)]'>
        正在连接对话服务
      </Text>
    </View>
  );
}

export default memo(ChatBubble);
