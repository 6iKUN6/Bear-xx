import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Cpu,
  FileInput,
  Search,
  Wrench,
} from "lucide-react";
import type { TaskTraceItem } from "@/api/types";
import { cn } from "@/lib/utils";

interface TraceViewerProps {
  trace: TaskTraceItem[];
  durationMs?: number | null;
  turnLabel?: string;
  className?: string;
}

type TraceLane = "input" | "model" | "tool";

const laneConfig: Record<
  TraceLane,
  { label: string; barClassName: string; icon: typeof FileInput }
> = {
  input: {
    label: "Input",
    barClassName: "bg-[var(--lb-text-secondary)]",
    icon: FileInput,
  },
  model: {
    label: "Model",
    barClassName: "bg-[var(--lb-info)]",
    icon: Cpu,
  },
  tool: {
    label: "Tools",
    barClassName: "bg-[var(--lb-success)]",
    icon: Wrench,
  },
};

/** Admin 的单轮溯源视图：以时间、阶段与节点详情三层呈现执行因果。 */
export function TraceViewer({
  trace,
  durationMs,
  turnLabel = "本轮",
  className,
}: TraceViewerProps) {
  const [query, setQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [activeTraceId, setActiveTraceId] = useState<string | null>(null);
  const [scrollRequestId, setScrollRequestId] = useState(0);
  const shouldScrollToActiveTraceRef = useRef(false);

  const sortedTrace = useMemo(
    () => [...trace].sort((a, b) => a.sequence - b.sequence),
    [trace],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleTrace = useMemo(
    () =>
      normalizedQuery
        ? sortedTrace.filter((item) =>
            traceSearchText(item).includes(normalizedQuery),
          )
        : sortedTrace,
    [normalizedQuery, sortedTrace],
  );
  const waterfall = useMemo(() => buildWaterfall(sortedTrace), [sortedTrace]);
  const actualDuration = durationMs ?? waterfall.durationMs;
  const modelCalls = sortedTrace.filter(
    (item) => item.type === "MODEL_CALL",
  ).length;
  const toolCalls = sortedTrace.filter(
    (item) => item.type === "TOOL_CALL",
  ).length;

  useEffect(() => {
    if (!activeTraceId || !shouldScrollToActiveTraceRef.current) {
      return;
    }

    const traceNode = document.getElementById(traceNodeId(activeTraceId));
    if (!traceNode) {
      return;
    }

    traceNode.scrollIntoView({ behavior: "smooth", block: "center" });
    shouldScrollToActiveTraceRef.current = false;
  }, [activeTraceId, scrollRequestId, visibleTrace]);

  const selectTrace = (
    id: string,
    detailAvailable: boolean,
    options?: { scrollToNode?: boolean },
  ) => {
    if (options?.scrollToNode) {
      shouldScrollToActiveTraceRef.current = true;
      setQuery("");
      setScrollRequestId((previous) => previous + 1);
    }
    setActiveTraceId(id);
    setExpandedIds((previous) =>
      detailAvailable && !(activeTraceId === id && previous.has(id))
        ? new Set([id])
        : new Set(),
    );
  };

  return (
    <section
      className={cn(
        "min-h-0 overflow-hidden rounded-md border border-[var(--lb-line-strong)] bg-[var(--lb-surface)] text-[var(--lb-text-primary)]",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--lb-line-soft)] px-4 py-3 text-xs text-[var(--lb-text-secondary)]">
        <TraceMetric
          icon={Clock3}
          label="Duration"
          value={formatDuration(actualDuration)}
        />
        <TraceMetric icon={FileInput} label="Turns" value="1" />
        <TraceMetric
          icon={Wrench}
          label="Calls"
          value={`${modelCalls + toolCalls}`}
          detail={
            modelCalls || toolCalls
              ? `${modelCalls} 模型 / ${toolCalls} 工具`
              : undefined
          }
        />
        <div className="relative ml-auto min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--lb-text-muted)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索节点、工具或摘要"
            aria-label="搜索执行轨迹"
            className="h-8 w-full rounded border border-[var(--lb-line-strong)] bg-[var(--lb-surface-strong)] py-1 pl-8 pr-2 text-xs text-[var(--lb-text-primary)] outline-none placeholder:text-[var(--lb-text-muted)] focus:border-[var(--lb-accent)]"
          />
        </div>
      </div>

      {sortedTrace.length > 0 ? (
        <>
          <div className="overflow-x-auto border-b border-[var(--lb-line-soft)] px-4 py-3">
            <div className="min-w-[34rem] space-y-1.5">
              {(Object.keys(laneConfig) as TraceLane[]).map((lane) => {
                const config = laneConfig[lane];
                const Icon = config.icon;
                return (
                  <div
                    key={lane}
                    className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2"
                  >
                    <span className="flex items-center gap-1 text-[11px] text-[var(--lb-text-muted)]">
                      <Icon className="h-3 w-3" />
                      {config.label}
                    </span>
                    <div className="relative h-3 overflow-hidden rounded-sm bg-[var(--lb-surface-hover)]">
                      {waterfall[lane].map((segment) => (
                        <button
                          type="button"
                          key={segment.item.id}
                          onClick={() =>
                            selectTrace(
                              segment.item.id,
                              hasNodeDetail(segment.item),
                              { scrollToNode: true },
                            )
                          }
                          title={`${segment.item.title} · ${formatDuration(segment.item.durationMs)}`}
                          aria-label={`查看${segment.item.title}节点`}
                          aria-pressed={activeTraceId === segment.item.id}
                          className={cn(
                            "absolute top-0 h-full min-w-[2px] cursor-pointer rounded-[2px] opacity-90 transition-opacity hover:opacity-100 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--lb-accent)]",
                            config.barClassName,
                            activeTraceId === segment.item.id &&
                              "z-10 opacity-100 ring-1 ring-[var(--lb-accent)] ring-offset-1 ring-offset-[var(--lb-surface-hover)]",
                          )}
                          style={{
                            left: `${segment.left}%`,
                            width: `${segment.width}%`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="border-b border-[var(--lb-line-soft)] px-4 py-2 text-[11px] font-medium uppercase text-[var(--lb-text-muted)]">
            {turnLabel}
            <span className="ml-2 font-normal normal-case text-[var(--lb-text-muted)]">
              {visibleTrace.length === sortedTrace.length
                ? `${sortedTrace.length} 个节点`
                : `显示 ${visibleTrace.length} / ${sortedTrace.length} 个节点`}
            </span>
          </div>

          <ol className="relative divide-y divide-[var(--lb-line-soft)] before:pointer-events-none before:absolute before:bottom-4 before:left-[1.85rem] before:top-4 before:w-px before:bg-[var(--lb-line-strong)]">
            {visibleTrace.length === 0 ? (
              <li className="px-4 py-10 text-center text-sm text-[var(--lb-text-muted)]">
                未找到匹配的轨迹节点
              </li>
            ) : (
              visibleTrace.map((item) => {
                const expanded = expandedIds.has(item.id);
                const active = activeTraceId === item.id;
                const category = traceCategory(item);
                const detailAvailable = hasNodeDetail(item);
                return (
                  <li
                    key={item.id}
                    id={traceNodeId(item.id)}
                    className={cn(
                      "relative",
                      active
                        ? "bg-[var(--lb-accent-soft)]"
                        : "bg-[var(--lb-surface)]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectTrace(item.id, detailAvailable)}
                      className={cn(
                        "grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-start gap-2 px-4 py-2.5 text-left",
                        "cursor-pointer hover:bg-[var(--lb-surface-hover)] focus-visible:bg-[var(--lb-surface-hover)] focus-visible:outline-none",
                      )}
                      style={{
                        paddingLeft: `${1 + Math.min(item.depth, 3) * 0.75}rem`,
                      }}
                      aria-expanded={detailAvailable ? expanded : undefined}
                    >
                      <span
                        className={cn(
                          "relative z-10 mt-1.5 h-2 w-2 rounded-full border-2 border-[var(--lb-surface)] bg-[var(--lb-text-muted)]",
                          active && "bg-[var(--lb-accent)]",
                        )}
                      />
                      <TraceTypeBadge category={category} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm leading-5 text-[var(--lb-text-primary)]">
                          {item.title}
                        </span>
                        {item.summary ? (
                          <span className="mt-0.5 block truncate text-xs leading-5 text-[var(--lb-text-secondary)]">
                            {item.summary}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 pt-0.5">
                        {item.durationMs != null ? (
                          <span className="text-[11px] tabular-nums text-[var(--lb-text-muted)]">
                            {formatDuration(item.durationMs)}
                          </span>
                        ) : null}
                        <TraceStatus status={item.status} />
                        {detailAvailable ? (
                          expanded ? (
                            <ChevronDown className="h-3.5 w-3.5 text-[var(--lb-text-muted)]" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-[var(--lb-text-muted)]" />
                          )
                        ) : null}
                      </span>
                    </button>
                    {expanded ? <TraceNodeDetail item={item} /> : null}
                  </li>
                );
              })
            )}
          </ol>
        </>
      ) : (
        <div className="px-4 py-12 text-center text-sm text-[var(--lb-text-muted)]">
          无执行轨迹
        </div>
      )}
    </section>
  );
}

function TraceMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <Icon className="h-3.5 w-3.5 text-[var(--lb-text-muted)]" />
      <span>{label}</span>
      <span className="font-medium tabular-nums text-[var(--lb-text-primary)]">
        {value}
      </span>
      {detail ? (
        <span className="text-[var(--lb-text-muted)]">{detail}</span>
      ) : null}
    </span>
  );
}

function TraceTypeBadge({
  category,
}: {
  category: ReturnType<typeof traceCategory>;
}) {
  const className = {
    input: "bg-[var(--lb-surface-hover)] text-[var(--lb-text-secondary)]",
    model: "bg-[var(--lb-info-soft)] text-[var(--lb-info)]",
    tool: "bg-[var(--lb-success-soft)] text-[var(--lb-success)]",
    approval: "bg-[var(--lb-warning-soft)] text-[var(--lb-warning)]",
    output: "bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]",
    error: "bg-[var(--lb-danger-soft)] text-[var(--lb-danger)]",
    flow: "bg-[var(--lb-info-soft)] text-[var(--lb-info)]",
  }[category.kind];

  return (
    <span
      className={cn(
        "mt-0.5 inline-flex min-w-[4.5rem] justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
        className,
      )}
    >
      {category.label}
    </span>
  );
}

function TraceStatus({ status }: { status: string }) {
  const className =
    status === "SUCCESS"
      ? "bg-[var(--lb-success)]"
      : status === "ERROR"
        ? "bg-[var(--lb-danger)]"
        : status === "RUNNING" || status === "WAITING_HUMAN"
          ? "bg-[var(--lb-warning)]"
          : "bg-[var(--lb-text-muted)]";

  return (
    <span
      className={cn("mt-1 h-1.5 w-1.5 rounded-full", className)}
      title={status}
    />
  );
}

function TraceNodeDetail({ item }: { item: TaskTraceItem }) {
  const facts = [
    item.toolName ? ["工具", item.toolName] : null,
    item.nodeKey ? ["节点", item.nodeKey] : null,
    item.mcpServer ? ["MCP", item.mcpServer] : null,
    item.mcpTool ? ["MCP 工具", item.mcpTool] : null,
  ].filter((fact): fact is [string, string] => Boolean(fact));

  return (
    <div
      className="border-t border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] px-4 py-3 text-xs"
      style={{ paddingLeft: `${1 + Math.min(item.depth, 3) * 0.75}rem` }}
    >
      {item.detail ? (
        <p className="mb-3 leading-5 text-[var(--lb-text-secondary)]">
          {item.detail}
        </p>
      ) : null}
      {facts.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[var(--lb-text-muted)]">
          {facts.map(([label, value]) => (
            <span key={label}>
              {label}{" "}
              <span className="text-[var(--lb-text-secondary)]">{value}</span>
            </span>
          ))}
        </div>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {item.inputSummary ? (
          <TracePayload title="输入" value={item.inputSummary} />
        ) : null}
        {item.outputSummary ? (
          <TracePayload title="输出" value={item.outputSummary} />
        ) : null}
        {item.metrics ? (
          <TracePayload title="指标" value={item.metrics} />
        ) : null}
        {item.error ? (
          <TracePayload title="错误" value={item.error} tone="error" />
        ) : null}
      </div>
    </div>
  );
}

function TracePayload({
  title,
  value,
  tone,
}: {
  title: string;
  value: Record<string, unknown>;
  tone?: "error";
}) {
  return (
    <div className="min-w-0">
      <p
        className={cn(
          "mb-1 font-medium text-[var(--lb-text-muted)]",
          tone === "error" && "text-[var(--lb-danger)]",
        )}
      >
        {title}
      </p>
      <pre className="max-h-48 overflow-auto rounded border border-[var(--lb-line-soft)] bg-[var(--lb-surface-strong)] p-2 text-[11px] leading-5 text-[var(--lb-text-secondary)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function traceCategory(item: TaskTraceItem) {
  if (item.status === "ERROR" || item.type === "ERROR") {
    return { kind: "error" as const, label: "ERROR" };
  }
  if (item.type === "MODEL_CALL") {
    return { kind: "model" as const, label: "MODEL" };
  }
  if (item.type === "TOOL_CALL") {
    return { kind: "tool" as const, label: "TOOL" };
  }
  if (item.type === "APPROVAL") {
    return { kind: "approval" as const, label: "APPROVAL" };
  }
  if (item.type === "MESSAGE_FINALIZE") {
    return { kind: "output" as const, label: "ASSISTANT" };
  }
  if (
    item.type === "AGENT_ROUTING" ||
    item.type === "STRATEGY_DECISION" ||
    item.type === "SKILL_SELECTION"
  ) {
    return { kind: "input" as const, label: "CONTEXT" };
  }
  return { kind: "flow" as const, label: "WORKFLOW" };
}

function traceSearchText(item: TaskTraceItem) {
  return [
    item.title,
    item.summary,
    item.detail,
    item.type,
    item.toolName,
    item.nodeKey,
    item.mcpServer,
    item.mcpTool,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase();
}

function hasNodeDetail(item: TaskTraceItem) {
  return Boolean(
    item.detail ||
    item.toolName ||
    item.nodeKey ||
    item.mcpServer ||
    item.mcpTool ||
    item.inputSummary ||
    item.outputSummary ||
    item.error ||
    item.metrics,
  );
}

function traceNodeId(traceId: string) {
  return `trace-node-${traceId}`;
}

function traceLane(item: TaskTraceItem): TraceLane {
  if (item.type === "MODEL_CALL" || item.type === "MESSAGE_FINALIZE") {
    return "model";
  }
  if (item.type === "TOOL_CALL" || item.type === "APPROVAL") {
    return "tool";
  }
  return "input";
}

function buildWaterfall(trace: TaskTraceItem[]) {
  const timestamps = trace.flatMap((item) => [
    traceStart(item),
    traceEnd(item),
  ]);
  const earliest = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const latest = timestamps.length > 0 ? Math.max(...timestamps) : earliest;
  const durationMs = Math.max(0, latest - earliest);
  const range = Math.max(1, latest - earliest);
  const result: Record<
    TraceLane,
    { item: TaskTraceItem; left: number; width: number }[]
  > = {
    input: [],
    model: [],
    tool: [],
  };

  for (const item of trace) {
    const start = traceStart(item);
    const end = traceEnd(item);
    result[traceLane(item)].push({
      item,
      left: ((start - earliest) / range) * 100,
      width: Math.max(1.2, ((end - start) / range) * 100),
    });
  }

  return { ...result, durationMs };
}

function traceStart(item: TaskTraceItem) {
  return item.startedAt ?? item.createdAt;
}

function traceEnd(item: TaskTraceItem) {
  const start = traceStart(item);
  return item.endedAt ?? start + Math.max(item.durationMs ?? 0, 1);
}

function formatDuration(value: number | null | undefined) {
  if (value == null) {
    return "-";
  }
  if (value < 1000) {
    return `${value}ms`;
  }
  return `${(value / 1000).toFixed(1)}s`;
}
