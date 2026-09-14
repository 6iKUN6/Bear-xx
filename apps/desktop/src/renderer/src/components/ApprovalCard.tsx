import { useState } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import {
  formatApprovalArgs,
  splitApprovalArgs,
} from "@litter-bear/chat-core";
import {
  APPROVAL_DECISION_LABELS,
  type ApprovalDecision,
  type ApprovalDecisionType,
  type ApprovalRequiredPayload,
} from "@litter-bear/types/protocol";

interface ApprovalCardProps {
  /** 后端 approval.required 事件载荷 */
  payload: ApprovalRequiredPayload;
  /** 提交中（恢复请求发起后禁用交互，避免重复提交） */
  submitting?: boolean;
  /** 已做出的决定；传入即收敛为一行结论（历史卡只读） */
  resolvedDecision?: ApprovalDecisionType;
  /** 提交人工决定 */
  onDecision?: (decision: ApprovalDecision) => void;
}

/**
 * 工具级人工审批卡片（HITL）
 * @description 待审批时展示工具名/说明/参数事实行，提供 通过 / 修改 / 拒绝 三态；
 * 嵌套与长文本参数收进「查看调用参数」折叠区，已处理的历史卡收敛为一行结论。
 * 纯展示组件：决定通过 onDecision 上抛，由上层调用 /approval 端点恢复续跑。
 */
export function ApprovalCard({
  payload,
  submitting = false,
  resolvedDecision,
  onDecision,
}: ApprovalCardProps) {
  const allowed = payload.allowedDecisions ?? ["approve", "reject"];
  const canApprove = allowed.includes("approve");
  const canReject = allowed.includes("reject");
  const canEdit = allowed.includes("edit");

  const [editing, setEditing] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [editText, setEditText] = useState(() => formatApprovalArgs(payload.args));
  const [parseError, setParseError] = useState<string | null>(null);

  // 已处理：整张卡收敛为一行结论
  if (resolvedDecision) {
    return <ResolvedLine toolName={payload.toolName} decision={resolvedDecision} />;
  }

  const disabled = submitting;
  const { facts, rawText } = splitApprovalArgs(payload.args);

  const emit = (decision: ApprovalDecision) => {
    if (!disabled) {
      onDecision?.(decision);
    }
  };

  const handleConfirmEdit = () => {
    if (disabled) {
      return;
    }
    try {
      const editedArgs = editText.trim()
        ? (JSON.parse(editText) as Record<string, unknown>)
        : {};
      setParseError(null);
      onDecision?.({ decision: "edit", editedArgs });
    } catch {
      setParseError("参数不是合法的 JSON");
    }
  };

  return (
    <div className="my-2.5 rounded-[var(--lb-radius-md)] border border-[var(--lb-warning)] bg-[var(--lb-surface)] p-3.5">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--lb-warning)] text-[12px] font-bold text-[var(--lb-on-accent)]">
          !
        </span>
        <span className="text-[13px] font-semibold">待人工确认</span>
        {payload.toolName && (
          <span className="rounded-full bg-[var(--lb-surface-hover)] px-2 py-0.5 font-mono text-[11px] text-[var(--lb-text-secondary)]">
            {payload.toolName}
          </span>
        )}
      </div>

      {payload.description && (
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--lb-text-secondary)]">
          {payload.description}
        </p>
      )}

      {editing ? (
        <div className="mt-2.5">
          <textarea
            value={editText}
            disabled={disabled}
            onChange={(e) => setEditText(e.target.value)}
            placeholder="编辑工具参数（JSON）"
            rows={Math.min(10, editText.split("\n").length + 1)}
            className="w-full resize-y rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] bg-[var(--lb-page-background)] p-2 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--lb-accent)] disabled:opacity-60"
          />
          {parseError && (
            <p className="mt-1 text-[12px] text-[var(--lb-danger)]">{parseError}</p>
          )}
        </div>
      ) : (
        <>
          {facts.length > 0 && (
            <div className="mt-2.5 flex flex-col gap-1.5">
              {facts.map((fact) => (
                <div key={fact.key} className="flex items-baseline gap-2 text-[12px]">
                  <span className="shrink-0 font-mono text-[var(--lb-text-muted)]">
                    {fact.key}
                  </span>
                  <span className="min-w-0 break-all text-[var(--lb-text-primary)]">
                    {fact.value}
                  </span>
                </div>
              ))}
            </div>
          )}

          {rawText && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="flex items-center gap-1 text-[12px] text-[var(--lb-text-secondary)] transition-colors hover:text-[var(--lb-text-primary)]"
              >
                <ChevronRight
                  size={12}
                  className={`transition-transform ${showRaw ? "rotate-90" : ""}`}
                />
                {showRaw ? "收起调用参数" : "查看调用参数"}
              </button>
              {showRaw && (
                <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-[var(--lb-radius-sm)] bg-[var(--lb-page-background)] p-2 font-mono text-[11px] leading-relaxed text-[var(--lb-text-secondary)]">
                  {rawText}
                </pre>
              )}
            </div>
          )}
        </>
      )}

      <div className="mt-3 flex items-center gap-2">
        {editing ? (
          <>
            <button
              type="button"
              onClick={handleConfirmEdit}
              disabled={disabled}
              className="lb-accent-surface inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] px-3 text-[12px] font-semibold text-[var(--lb-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              确认修改并执行
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setParseError(null);
                setEditText(formatApprovalArgs(payload.args));
              }}
              className="inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] px-3 text-[12px] transition-colors hover:bg-[var(--lb-surface-hover)]"
            >
              取消
            </button>
          </>
        ) : (
          <>
            {canApprove && (
              <button
                type="button"
                onClick={() => emit({ decision: "approve" })}
                disabled={disabled}
                className="lb-accent-surface inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] px-3 text-[12px] font-semibold text-[var(--lb-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? "处理中…" : "通过"}
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => !disabled && setEditing(true)}
                disabled={disabled}
                className="inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] px-3 text-[12px] transition-colors hover:bg-[var(--lb-surface-hover)] disabled:opacity-50"
              >
                修改参数
              </button>
            )}
            {canReject && (
              <button
                type="button"
                onClick={() => emit({ decision: "reject" })}
                disabled={disabled}
                className="inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] border border-[var(--lb-danger)] px-3 text-[12px] text-[var(--lb-danger)] transition-colors hover:bg-[var(--lb-surface-hover)] disabled:opacity-50"
              >
                拒绝
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 已处理审批的一行结论 */
function ResolvedLine({
  toolName,
  decision,
}: {
  toolName?: string;
  decision: ApprovalDecisionType;
}) {
  const rejected = decision === "reject";
  return (
    <div
      className={`my-2 flex items-center gap-1.5 text-[12px] ${
        rejected ? "text-[var(--lb-danger)]" : "text-[var(--lb-success)]"
      }`}
    >
      {rejected ? <X size={13} /> : <Check size={13} />}
      <span>
        {APPROVAL_DECISION_LABELS[decision]}
        {toolName ? ` · ${toolName}` : ""}
      </span>
    </div>
  );
}
