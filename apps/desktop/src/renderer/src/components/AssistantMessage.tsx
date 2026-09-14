import type { ConversationMessage } from "@/api/types";
import { useChatStore } from "@/stores/chat-store";
import { ApprovalCard } from "@/components/ApprovalCard";
import { MarkdownContent } from "@/components/MarkdownContent";
import { StreamingMarkdownContent } from "@/components/StreamingMarkdownContent";
import { TraceBlock } from "@/components/TraceBlock";

/**
 * 单条助手消息：执行轨迹 + HITL 审批卡 + markdown 正文（Codex 风格直排，无气泡卡片）
 * @description 轨迹与审批是消息级运行态，正文统一走 @litter-bear/markdown 渲染；
 * 流式时用 StreamingMarkdownContent 叠末尾 shimmer。
 */
export function AssistantMessage({ message }: { message: ConversationMessage }) {
  const streaming = message.status === "streaming";
  const approvalSubmitting = useChatStore((s) => s.approvalSubmitting);
  const toggleStreamFeedback = useChatStore((s) => s.toggleStreamFeedback);
  const submitApproval = useChatStore((s) => s.submitApproval);

  return (
    <div className="self-stretch">
      <TraceBlock
        feedback={message.streamFeedback}
        metrics={message.metrics}
        streaming={streaming}
        onToggle={() => toggleStreamFeedback(message.id)}
      />

      {message.pendingApproval && (
        <ApprovalCard
          payload={message.pendingApproval}
          submitting={approvalSubmitting}
          onDecision={(decision) => submitApproval(message.id, decision)}
        />
      )}
      {!message.pendingApproval && message.resolvedApproval && (
        <ApprovalCard
          payload={message.resolvedApproval.payload}
          resolvedDecision={message.resolvedApproval.decision}
        />
      )}

      {streaming && !message.content ? (
        <div className="animate-[lb-pulse_1.2s_ease-in-out_infinite] text-sm leading-[1.75] text-[var(--lb-text-secondary)]">
          正在处理…
        </div>
      ) : message.status === "error" ? (
        <div className="whitespace-pre-wrap text-sm leading-[1.75] text-[var(--lb-danger)]">
          {message.content}
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
    </div>
  );
}
