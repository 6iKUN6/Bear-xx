import { memo, useState } from "react";
import { Text, View } from "@tarojs/components";
import {
  buildStreamTraceRows,
  formatStreamFeedbackStatus,
  formatTraceRowDuration,
  type StreamTraceRow,
} from "../../utils/streamFeedback";
import "./index.scss";

interface StreamFeedbackProps {
  feedback?: MessageStreamFeedbackState;
  fallbackCurrent?: MessageStreamEventFeedback;
  /** 本轮运行指标（token / 耗时 / 缓存），用于直答行与轨迹尾注 */
  metrics?: MessageRunMetrics | null;
  streaming?: boolean;
  onToggle?: () => void;
}

/**
 * 执行轨迹（Codex 客户端风格）
 * @description 直答（无工具、无多步编排）收敛为一行「直接回答 · 耗时 · tokens」；
 * 多步则为扁平行列表：状态符号（✓/●/✗）+ 等宽动作名 + 人话摘要 + 耗时，
 * 点击行展开该步入参/出参细节。默认收起为一行摘要，点击展开完整轨迹。
 * 不透出策略名 / 节点 key 等内部术语。
 */
function StreamFeedback({
  feedback,
  fallbackCurrent,
  metrics,
  streaming = false,
  onToggle,
}: StreamFeedbackProps) {
  const normalizedFeedback = normalizeFeedback(feedback, fallbackCurrent);
  const current = normalizedFeedback.current;
  const events = normalizedFeedback.events;
  const expanded = normalizedFeedback.expanded;
  const rows = buildStreamTraceRows(events, streaming);
  const hasRows = rows.length > 0;
  const summary = readRunSummary(metrics);

  // 没有任何轨迹也没有运行指标时不占位
  if (!current && !hasRows && !summary) {
    return null;
  }

  // 直答：无步骤可展开，收敛为一行结论（不再有二级折叠）
  if (!hasRows && !streaming) {
    return (
      <View className='mb-[0.625rem] w-full max-w-full'>
        <View className='trace-direct'>
          <Text className='trace-direct-dot' />
          <Text className='trace-direct-text'>
            {joinInline(["直接回答", summary])}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className='mb-[0.625rem] w-full max-w-full'>
      <View className='trace-head' onClick={onToggle}>
        {streaming ? (
          <LiveStatus current={current} events={events} />
        ) : (
          <View className='trace-direct'>
            <Text className='trace-direct-dot' />
            <Text className='trace-direct-text'>
              {expanded
                ? `${rows.length} 个步骤`
                : joinInline([`${rows.length} 个步骤`, summary])}
            </Text>
          </View>
        )}
        {hasRows && (
          <Text
            className={`trace-head-caret ${expanded ? "trace-head-caret-open" : ""}`}
          >
            ▸
          </Text>
        )}
      </View>

      {expanded && hasRows && (
        <View className='trace-codex'>
          {rows.map((row) => (
            <TraceRowView key={row.key} row={row} />
          ))}
          {summary && <Text className='trace-codex-foot'>{summary}</Text>}
        </View>
      )}
    </View>
  );
}

/** 流式进行中的单行状态（ shimmer ） */
function LiveStatus({
  current,
  events,
}: {
  current?: MessageStreamEventFeedback;
  events: MessageStreamEventFeedback[];
}) {
  const text = current
    ? formatStreamFeedbackStatus(current, events)
    : "正在处理";

  return (
    <Text className='stream-feedback-current-text stream-feedback-current-text-live'>
      {text}
    </Text>
  );
}

/** 单行执行轨迹：状态符号 + 动作名 + 摘要 + 耗时 + 细节展开 */
function TraceRowView({ row }: { row: StreamTraceRow }) {
  const [open, setOpen] = useState(false);
  const duration = formatTraceRowDuration(row.durationMs);
  const toggleable = Boolean(row.detail);

  return (
    <View>
      <View
        className={`cx-row ${open ? "cx-row-open" : ""}`}
        onClick={() => toggleable && setOpen((value) => !value)}
      >
        <Text className={`cx-glyph cx-glyph-${row.status}`}>{glyph(row.status)}</Text>
        <Text className='cx-name'>{row.name}</Text>
        {row.summary && <Text className='cx-summary'>{row.summary}</Text>}
        {duration && <Text className='cx-ms'>{duration}</Text>}
        {toggleable && <Text className='cx-caret'>▸</Text>}
      </View>
      {open && row.detail && <Text className='cx-detail'>{row.detail}</Text>}
    </View>
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

function normalizeFeedback(
  feedback?: MessageStreamFeedbackState,
  fallbackCurrent?: MessageStreamEventFeedback,
): MessageStreamFeedbackState {
  if (feedback) {
    return feedback;
  }

  return {
    current: fallbackCurrent,
    events: fallbackCurrent ? [fallbackCurrent] : [],
    expanded: false,
  };
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

export default memo(StreamFeedback);
