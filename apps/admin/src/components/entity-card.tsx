import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 实体卡片网格：任务/智能体/Flow/模型预设这类「每行一个对象」的列表统一用它排布。
 * @description 替代逐行表格——卡片把单个实体的名称、状态、统计、操作收进一框，扫读时一眼锁定对象，
 * 不用在列之间来回对位。明细类（错误/日志）仍用表格，不进这里。
 */
export function EntityCardGrid({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
      {...props}
    />
  );
}

/** 单个实体卡片：白底 + 细边 + 轻阴影，hover 微微浮起提示可点。 */
export function EntityCard({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md",
        className,
      )}
      {...props}
    />
  );
}

/** 卡片底部操作行：状态徽章靠左、操作按钮靠右。 */
export function EntityCardFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mt-auto flex items-center justify-between gap-2 pt-3",
        className,
      )}
      {...props}
    />
  );
}
