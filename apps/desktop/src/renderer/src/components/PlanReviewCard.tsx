import { useState } from "react";
import { Check, ListChecks, X } from "lucide-react";
import {
  PLAN_REVIEW_DECISION_LABELS,
  type FlowPlanReviewApprovalPayload,
  type PlanReviewDecision,
  type PlanReviewDecisionType,
} from "@litter-bear/types/protocol";

interface PlanReviewCardProps {
  /** flow.waiting_human 中的计划审批载荷 */
  payload: FlowPlanReviewApprovalPayload;
  /** 提交中（恢复请求发起后禁用交互，避免重复提交） */
  submitting?: boolean;
  /** 已做出的决定；传入即收敛为一行结论 */
  resolvedDecision?: PlanReviewDecisionType;
  /** 提交计划审批决定 */
  onDecision?: (decision: PlanReviewDecision) => void;
}

/**
 * 计划审批卡片（plan-review HITL）
 * @description 出计划后、执行前展示可确认的步骤清单：可改每步文字、可末尾追加步骤，
 * 提供 通过 / 打回重规划 / 终止；改过任一步后主按钮变为「确认修改并执行」（edit）。
 * 允许的决定只来自后端下发的 allowedDecisions。
 */
export function PlanReviewCard({
  payload,
  submitting = false,
  resolvedDecision,
  onDecision,
}: PlanReviewCardProps) {
  const allowed = payload.allowedDecisions;
  const original = payload.steps.map((step) => step.goal);
  const [goals, setGoals] = useState<string[]>(original);
  const [replanning, setReplanning] = useState(false);
  const [feedback, setFeedback] = useState("");

  if (resolvedDecision) {
    return <ResolvedLine decision={resolvedDecision} />;
  }

  const disabled = submitting;
  const dirty =
    goals.length !== original.length ||
    goals.some((goal, index) => goal !== original[index]);
  const editedSteps = goals
    .map((goal) => goal.trim())
    .filter(Boolean)
    .map((goal) => ({ goal }));
  // 「修改后执行」需要后端允许 edit，且不能把计划改空
  const primaryAllowed = dirty
    ? allowed.includes("edit") && editedSteps.length > 0
    : allowed.includes("approve");

  const emit = (decision: PlanReviewDecision) => {
    if (!disabled) onDecision?.(decision);
  };

  return (
    <div className="my-2.5 rounded-[var(--lb-radius-md)] border border-[var(--lb-warning)] bg-[var(--lb-surface)] p-3.5">
      <div className="flex items-center gap-2">
        <ListChecks size={16} className="text-[var(--lb-warning)]" />
        <span className="text-[13px] font-semibold">待确认执行计划</span>
        {payload.revision > 0 && (
          <span className="rounded-full bg-[var(--lb-surface-hover)] px-2 py-0.5 text-[11px] text-[var(--lb-text-secondary)]">
            第 {payload.revision + 1} 版
          </span>
        )}
      </div>

      <ol className="mt-2.5 flex flex-col gap-1.5">
        {goals.map((goal, index) => (
          <li key={index} className="flex items-start gap-2">
            <span className="mt-1.5 w-4 shrink-0 text-right font-mono text-[11px] text-[var(--lb-text-muted)]">
              {index + 1}
            </span>
            <textarea
              value={goal}
              disabled={disabled || !allowed.includes("edit")}
              rows={1}
              placeholder="步骤目标"
              onChange={(e) =>
                setGoals((prev) =>
                  prev.map((item, i) => (i === index ? e.target.value : item)),
                )
              }
              className="min-h-8 w-full resize-y rounded-[var(--lb-radius-sm)] border border-transparent bg-[var(--lb-page-background)] px-2 py-1.5 text-[13px] leading-relaxed outline-none focus:border-[var(--lb-accent)] disabled:opacity-80"
            />
          </li>
        ))}
      </ol>
      {allowed.includes("edit") && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setGoals((prev) => [...prev, ""])}
          className="mt-1.5 ml-6 text-[12px] text-[var(--lb-text-secondary)] transition-colors hover:text-[var(--lb-text-primary)] disabled:opacity-50"
        >
          + 追加一步
        </button>
      )}

      {replanning && (
        <textarea
          value={feedback}
          disabled={disabled}
          onChange={(e) => setFeedback(e.target.value)}
          rows={2}
          placeholder="说明哪里需要调整（可选），将据此重新规划"
          className="mt-2.5 w-full resize-y rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] bg-[var(--lb-page-background)] p-2 text-[13px] leading-relaxed outline-none focus:border-[var(--lb-accent)] disabled:opacity-60"
        />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {replanning ? (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                emit({ decision: "reject_replan", feedback: feedback.trim() })
              }
              className="lb-accent-surface inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] px-3 text-[12px] font-semibold text-[var(--lb-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "处理中…" : "提交并重新规划"}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setReplanning(false)}
              className="inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] px-3 text-[12px] transition-colors hover:bg-[var(--lb-surface-hover)] disabled:opacity-50"
            >
              取消
            </button>
          </>
        ) : (
          <>
            {(allowed.includes("approve") || allowed.includes("edit")) && (
              <button
                type="button"
                disabled={disabled || !primaryAllowed}
                onClick={() =>
                  emit(
                    dirty
                      ? { decision: "edit", editedSteps }
                      : { decision: "approve" },
                  )
                }
                className="lb-accent-surface inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] px-3 text-[12px] font-semibold text-[var(--lb-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? "处理中…" : dirty ? "确认修改并执行" : "按计划执行"}
              </button>
            )}
            {allowed.includes("reject_replan") && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => setReplanning(true)}
                className="inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] px-3 text-[12px] transition-colors hover:bg-[var(--lb-surface-hover)] disabled:opacity-50"
              >
                打回重新规划
              </button>
            )}
            {allowed.includes("reject_terminate") && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => emit({ decision: "reject_terminate" })}
                className="inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] border border-[var(--lb-danger)] px-3 text-[12px] text-[var(--lb-danger)] transition-colors hover:bg-[var(--lb-surface-hover)] disabled:opacity-50"
              >
                终止任务
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 已处理计划审批的一行结论 */
function ResolvedLine({ decision }: { decision: PlanReviewDecisionType }) {
  const stopped = decision === "reject_terminate";
  return (
    <div
      className={`my-2 flex items-center gap-1.5 text-[12px] ${
        stopped ? "text-[var(--lb-danger)]" : "text-[var(--lb-success)]"
      }`}
    >
      {stopped ? <X size={13} /> : <Check size={13} />}
      <span>{PLAN_REVIEW_DECISION_LABELS[decision]}</span>
    </div>
  );
}
