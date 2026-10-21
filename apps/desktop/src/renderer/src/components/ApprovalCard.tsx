import { useState } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import { formatApprovalArgs, splitApprovalArgs } from "@litter-bear/chat-core";
import {
  APPROVAL_DECISION_LABELS,
  type ApprovalDecision,
  type ApprovalDecisionType,
  type FlowToolApprovalPayload,
  type FlowToolApprovalRequest,
} from "@litter-bear/types/protocol";

interface ApprovalCardProps {
  /** flow.waiting_human 中的工具审批批次 */
  payload: FlowToolApprovalPayload;
  /** 提交中（恢复请求发起后禁用交互，避免重复提交） */
  submitting?: boolean;
  /** 已做出的决定；传入即收敛为一行结论 */
  resolvedDecision?: ApprovalDecisionType;
  /** 提交人工决定 */
  onDecision?: (decision: ApprovalDecision) => void;
}

/**
 * 工具级人工审批卡片（HITL）
 * @description 一次 interrupt 可能包含多个工具请求，它们组成不可拆分的批次、共用一个决定。
 * 每个请求展示工具名 / 说明 / 参数事实行，嵌套与长文本参数收进折叠区；
 * 只有单个请求且后端允许时才能「修改参数」——一份改后参数无法安全映射到多个工具。
 * 纯展示组件：决定通过 onDecision 上抛，由上层调用 /approval 端点恢复续跑。
 */
export function ApprovalCard({
  payload,
  submitting = false,
  resolvedDecision,
  onDecision,
}: ApprovalCardProps) {
  const allowed = payload.allowedDecisions;
  const single = payload.requests.length === 1 ? payload.requests[0] : null;
  const canApprove = allowed.includes("approve");
  const canReject = allowed.includes("reject");
  const canEdit = Boolean(single) && allowed.includes("edit");

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(() =>
    formatApprovalArgs(single?.args),
  );
  const [parseError, setParseError] = useState<string | null>(null);

  if (resolvedDecision) {
    return (
      <ResolvedLine
        toolNames={payload.requests.map((request) => request.toolName)}
        decision={resolvedDecision}
      />
    );
  }

  const disabled = submitting;
  const emit = (decision: ApprovalDecision) => {
    if (!disabled) onDecision?.(decision);
  };

  const handleConfirmEdit = () => {
    if (disabled) return;
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
        {payload.requests.length > 1 && (
          <span className="text-[12px] text-[var(--lb-text-secondary)]">
            {payload.requests.length} 个操作需一起确认
          </span>
        )}
      </div>

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
            <p className="mt-1 text-[12px] text-[var(--lb-danger)]">
              {parseError}
            </p>
          )}
        </div>
      ) : (
        payload.requests.map((request) => (
          <RequestDetail key={request.index} request={request} />
        ))
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
                setEditText(formatApprovalArgs(single?.args));
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

/** 单个工具请求的说明与参数事实行 */
function RequestDetail({ request }: { request: FlowToolApprovalRequest }) {
  const [showRaw, setShowRaw] = useState(false);
  const { facts, rawText } = splitApprovalArgs(request.args);
  return (
    <div className="mt-2.5">
      <span className="rounded-full bg-[var(--lb-surface-hover)] px-2 py-0.5 font-mono text-[11px] text-[var(--lb-text-secondary)]">
        {request.toolName}
      </span>
      {request.description && (
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--lb-text-secondary)]">
          {request.description}
        </p>
      )}
      {facts.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
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
    </div>
  );
}

/** 已处理审批的一行结论 */
function ResolvedLine({
  toolNames,
  decision,
}: {
  toolNames: string[];
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
        {toolNames.length ? ` · ${toolNames.join("、")}` : ""}
      </span>
    </div>
  );
}
