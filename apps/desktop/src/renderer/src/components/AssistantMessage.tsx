import { BrandTile } from "./BrandTile";
import { CopyButton } from "./ui";
import type { ConversationMessage } from "@/api/types";
import { useChatStore } from "@/stores/chat-store";
import { ApprovalCard } from "@/components/ApprovalCard";
import { PlanReviewCard } from "@/components/PlanReviewCard";
import { MarkdownContent } from "@/components/MarkdownContent";
import { StreamingMarkdownContent } from "@/components/StreamingMarkdownContent";
import { TraceBlock } from "@/components/TraceBlock";

/**
 * 单条助手消息：执行轨迹 + HITL 审批卡 + markdown 正文（Codex 风格直排，无气泡卡片）
 * @description 轨迹与审批是消息级运行态，正文统一走 @litter-bear/markdown 渲染；
 * 流式时用 StreamingMarkdownContent 叠末尾 shimmer。
 */
export function AssistantMessage({
  message,
}: {
  message: ConversationMessage;
}) {
  const streaming = message.status === "streaming";
  const approvalSubmitting = useChatStore((s) => s.approvalSubmitting);
  const toggleStreamFeedback = useChatStore((s) => s.toggleStreamFeedback);
  const submitApproval = useChatStore((s) => s.submitApproval);
  const submitPlanReview = useChatStore((s) => s.submitPlanReview);
  const pending = message.pendingApproval?.approval;
  const resolved = message.resolvedApproval;

  return (
    <div className="assistant-message">
      <div className="message-author">
        <BrandTile size={21} />
        <span>Sola</span>
      </div>
      <TraceBlock
        feedback={message.streamFeedback}
        metrics={message.metrics}
        streaming={streaming}
        onToggle={() => toggleStreamFeedback(message.id)}
      />

      {pending?.kind === "tool" && (
        <ApprovalCard
          // 同一消息可能先后出现多次审批，换 approvalId 时重建卡片内部编辑态
          key={message.pendingApproval?.approvalId}
          payload={pending}
          submitting={approvalSubmitting}
          onDecision={(decision) => submitApproval(message.id, decision)}
        />
      )}
      {pending?.kind === "plan-review" && (
        <PlanReviewCard
          key={message.pendingApproval?.approvalId}
          payload={pending}
          submitting={approvalSubmitting}
          onDecision={(decision) => submitPlanReview(message.id, decision)}
        />
      )}
      {!pending && resolved?.kind === "tool" && (
        <ApprovalCard
          payload={resolved.payload}
          resolvedDecision={resolved.decision}
        />
      )}
      {!pending && resolved?.kind === "plan-review" && (
        <PlanReviewCard
          payload={resolved.payload}
          resolvedDecision={resolved.decision}
        />
      )}

      {streaming && !message.content ? (
        <div className="animate-[lb-pulse_1.2s_ease-in-out_infinite] text-sm leading-[1.75] text-[var(--lb-text-secondary)]">
          正在处理…
        </div>
      ) : streaming ? (
        <div className="text-sm leading-[1.75]">
          <StreamingMarkdownContent content={message.content} streaming />
        </div>
      ) : (
        <div className="text-sm leading-[1.75]">
          <MarkdownContent content={message.content} />
        </div>
      )}
      {message.status === "error" && (
        <p className="message-error" role="alert">
          {message.errorMessage || "生成失败，请重试。"}
        </p>
      )}
      {message.canceled && <p className="muted text-xs mt-2">已停止生成</p>}
      {!streaming && message.content && (
        <div className="message-actions">
          <CopyButton content={message.content} />
        </div>
      )}
    </div>
  );
}
