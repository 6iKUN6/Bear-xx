import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  buildStreamTraceRows,
  formatStreamFeedbackStatus,
  formatTraceRowDuration,
  type MessageRunMetrics,
  type MessageStreamFeedbackState,
  type StreamTraceRow,
} from "@litter-bear/chat-core";

interface TraceBlockProps {
  feedback?: MessageStreamFeedbackState;
  /** 本轮运行指标（token / 耗时 / 缓存），用于直答行与轨迹尾注 */
  metrics?: MessageRunMetrics | null;
  streaming?: boolean;
  onToggle?: () => void;
}

/**
 * 执行轨迹（Codex 客户端风格）
 * @description 直答（无工具、无多步编排）收敛为一行「直接回答 · 耗时 · tokens」；
 * 多步则为扁平行列表：状态符号 + 动作名 + 人话摘要 + 耗时，点击行展开入参/出参。
 * 默认收起为一行摘要，点击展开完整轨迹。不透出策略名 / 节点 key 等内部术语。
 * 行构建与文案在 @litter-bear/chat-core，与小程序端共用。
 */
export function TraceBlock({ feedback, metrics, streaming = false, onToggle }: TraceBlockProps) {
  const current = feedback?.current;
  const events = feedback?.events ?? [];
  const expanded = feedback?.expanded ?? false;
  const rows = buildStreamTraceRows(events, streaming);
  const hasRows = rows.length > 0;
  const summary = readRunSummary(metrics);

  // 没有任何轨迹也没有运行指标时不占位
  if (!current && !hasRows && !summary) {
    return null;
  }

  // 直答：无步骤可展开，收敛为一行结论
  if (!hasRows && !streaming) {
    return (
      <div className="mb-2.5 flex items-center gap-2 text-[12px] text-[var(--lb-text-muted)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--lb-text-muted)]" />
        <span>{joinInline(["直接回答", summary])}</span>
      </div>
    );
  }

  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left text-[12px] text-[var(--lb-text-secondary)] transition-colors hover:text-[var(--lb-text-primary)]"
      >
        {streaming ? (
          <span className="animate-[lb-pulse_1.2s_ease-in-out_infinite]">
            {current ? formatStreamFeedbackStatus(current, events) : "正在处理"}
          </span>
        ) : (
          <>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lb-text-muted)]" />
            <span>
              {expanded
                ? `${rows.length} 个步骤`
                : joinInline([`${rows.length} 个步骤`, summary])}
            </span>
          </>
        )}
        {hasRows && (
          <ChevronRight
            size={13}
            className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        )}
      </button>

      {expanded && hasRows && (
        <div className="mt-1.5 flex flex-col gap-0.5 border-l border-[var(--lb-line-soft)] pl-3">
          {rows.map((row) => (
            <TraceRowView key={row.key} row={row} />
          ))}
          {summary && (
            <div className="pt-1 text-[11px] text-[var(--lb-text-muted)]">{summary}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** 单行执行轨迹：状态符号 + 动作名 + 摘要 + 耗时 + 细节展开 */
function TraceRowView({ row }: { row: StreamTraceRow }) {
  const [open, setOpen] = useState(false);
  const duration = formatTraceRowDuration(row.durationMs);
  const toggleable = Boolean(row.detail);

  return (
    <div>
      <button
        type="button"
        onClick={() => toggleable && setOpen((v) => !v)}
        className={`flex w-full items-baseline gap-2 rounded px-1 py-1 text-left text-[12px] ${
          toggleable ? "transition-colors hover:bg-[var(--lb-surface-hover)]" : "cursor-default"
        }`}
      >
        <span
          className={`shrink-0 font-mono ${
            row.status === "done"
              ? "text-[var(--lb-success)]"
              : row.status === "fail"
                ? "text-[var(--lb-danger)]"
                : "text-[var(--lb-accent)] animate-[lb-pulse_1.2s_ease-in-out_infinite]"
          }`}
        >
          {glyph(row.status)}
        </span>
        <span className="shrink-0 font-mono text-[var(--lb-text-primary)]">{row.name}</span>
        {row.summary && (
          <span className="min-w-0 flex-1 truncate text-[var(--lb-text-secondary)]">
            {row.summary}
          </span>
        )}
        {duration && (
          <span className="shrink-0 tabular-nums text-[var(--lb-text-muted)]">{duration}</span>
        )}
        {toggleable && (
          <ChevronRight
            size={12}
            className={`shrink-0 self-center text-[var(--lb-text-muted)] transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && row.detail && (
        <pre className="mx-1 mb-1 overflow-x-auto whitespace-pre-wrap rounded-[var(--lb-radius-sm)] bg-[var(--lb-surface-muted)] p-2 font-mono text-[11px] leading-relaxed text-[var(--lb-text-secondary)]">
          {row.detail}
        </pre>
      )}
    </div>
  );
}

function glyph(status: StreamTraceRow["status"]) {
  if (status === "done") {
    return "✓";
  }
  if (status === "fail") {
    return "✗";
  }
  return "●";
}

/** 运行指标摘要：耗时 · tokens · 缓存命中 */
function readRunSummary(metrics?: MessageRunMetrics | null) {
  if (!metrics) {
    return undefined;
  }
  const tokenUsage = metrics.tokenUsage;
  const totalTokens = tokenUsage?.totalTokens;
  const cachedTokens =
    tokenUsage?.cachedInputTokens ?? metrics.cache?.cachedInputTokens;
  const cacheHit =
    Boolean(metrics.cache?.providerPromptCacheHit) ||
    Boolean(metrics.cache?.contextCacheHit) ||
    Boolean(cachedTokens && cachedTokens > 0);
  const duration = formatTraceRowDuration(metrics.durationMs);

  const parts = [
    duration,
    totalTokens
      ? `${formatCompactNumber(totalTokens)} tokens${tokenUsage?.estimated ? " 估算" : ""}`
      : undefined,
    cacheHit ? "缓存命中" : undefined,
  ].filter((part): part is string => Boolean(part));

  return parts.length ? parts.join(" · ") : undefined;
}

function joinInline(parts: Array<string | undefined>) {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
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
