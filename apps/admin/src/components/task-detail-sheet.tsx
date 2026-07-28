import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useTaskDetail } from "@/hooks/queries";
import {
  formatDuration,
  formatNumber,
  statusBadgeVariant,
} from "@/lib/format";

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
      <SheetContent>
        <SheetHeader>
          <SheetTitle>任务详情</SheetTitle>
          <SheetDescription>{taskId}</SheetDescription>
        </SheetHeader>

        {isLoading || !data ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="智能体" value={data.agentId ?? "默认"} />
              <Field
                label="状态"
                value={
                  <Badge variant={statusBadgeVariant(data.status)}>
                    {data.status}
                  </Badge>
                }
              />
              <Field label="时长" value={formatDuration(data.durationMs)} />
              <Field label="Token" value={formatNumber(data.totalTokens)} />
              <Field label="工具调用" value={data.toolCallCount ?? 0} />
              <Field label="模型调用" value={data.modelCallCount ?? 0} />
            </div>

            {data.errorMessage ? (
              <div className="rounded-md bg-[var(--lb-danger-soft)] p-3 text-sm text-[var(--lb-danger)]">
                {data.errorMessage}
              </div>
            ) : null}

            <div>
              <p className="mb-3 text-sm font-medium text-foreground">
                执行轨迹
              </p>
              {data.trace.length > 0 ? (
                <ol className="relative space-y-4 border-l border-border pl-4">
                  {data.trace.map((item) => (
                    <li key={item.id} className="relative">
                      <span className="absolute -left-[1.3rem] top-1 h-2 w-2 rounded-full bg-primary" />
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {item.title}
                        </span>
                        <Badge variant={statusBadgeVariant(item.status)}>
                          {item.status}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span>{item.type}</span>
                        {item.toolName ? <span>工具 {item.toolName}</span> : null}
                        {item.durationMs != null ? (
                          <span>{formatDuration(item.durationMs)}</span>
                        ) : null}
                      </div>
                      {item.summary ? (
                        <p className="mt-1 text-xs text-foreground/80">
                          {item.summary}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">无轨迹记录</p>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 font-medium text-foreground">{value}</div>
    </div>
  );
}
