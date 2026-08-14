import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentIdentity } from "@/components/agent-identity";
import { TraceViewer } from "@/components/trace-viewer";
import { useTaskDetail } from "@/hooks/queries";
import { formatNumber, statusBadgeVariant } from "@/lib/format";

export function TaskDetailSheet({
  taskId,
  onClose,
}: {
  taskId: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useTaskDetail(taskId);

  return (
    <Sheet open={Boolean(taskId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className="gap-0 overflow-hidden p-0"
        style={{ width: "min(100vw, 74rem)", maxWidth: "74rem" }}
      >
        <SheetHeader className="border-b border-border px-6 py-4">
          <SheetTitle>任务轨迹</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {taskId}
          </SheetDescription>
        </SheetHeader>

        {isLoading || !data ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <span>
                状态{" "}
                <Badge variant={statusBadgeVariant(data.status)}>
                  {data.status}
                </Badge>
              </span>
              <AgentIdentity
                name={data.agentName}
                avatar={data.agentAvatar}
                compact
              />
              <span>
                Token{" "}
                <strong className="font-medium tabular-nums text-foreground">
                  {formatNumber(data.totalTokens)}
                </strong>
              </span>
              <span>模型 {data.modelCallCount ?? 0} 次</span>
              <span>工具 {data.toolCallCount ?? 0} 次</span>
            </div>

            {data.errorMessage ? (
              <div className="mb-4 rounded border border-[var(--lb-danger)] bg-[var(--lb-danger-soft)] p-3 text-sm text-[var(--lb-danger)]">
                {data.errorMessage}
              </div>
            ) : null}

            <TraceViewer trace={data.trace} durationMs={data.durationMs} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
