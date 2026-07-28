import type { BadgeProps } from "@/components/ui/badge";

/** 毫秒 → 友好时长 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 0-1 → 百分比 */
export function formatPercent(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("zh-CN");
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 任务/trace 状态 → badge 变体 */
export function statusBadgeVariant(status: string): BadgeProps["variant"] {
  const s = status.toUpperCase();
  if (s === "COMPLETED" || s === "SUCCESS") return "success";
  if (s === "ERROR") return "destructive";
  if (s === "WAITING_HUMAN" || s === "PAUSED" || s === "RUNNING") return "warning";
  if (s === "CANCELED" || s === "EXPIRED" || s === "SKIPPED") return "secondary";
  return "info";
}

/** 图表色板（取 --lb-accent 系列 + 语义色，运行时读 CSS 变量） */
export function chartColors(): string[] {
  const styles = getComputedStyle(document.documentElement);
  const get = (name: string) => styles.getPropertyValue(name).trim();
  return [
    get("--lb-accent"),
    get("--lb-info"),
    get("--lb-success"),
    get("--lb-warning"),
    get("--lb-accent-strong"),
    get("--lb-danger"),
  ].filter(Boolean);
}
