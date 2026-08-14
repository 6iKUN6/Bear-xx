import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/kpi-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskDetailSheet } from "@/components/task-detail-sheet";
import { AgentIdentity } from "@/components/agent-identity";
import { useRecentTasks } from "@/hooks/queries";
import { useUiStore } from "@/stores/ui-store";
import {
  formatDuration,
  formatNumber,
  formatTime,
  statusBadgeVariant,
} from "@/lib/format";

export function TasksPage() {
  const days = useUiStore((s) => s.rangeDays);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useRecentTasks(days, cursor);
  const rows = data?.items ?? [];

  const goNext = () => {
    if (data?.nextCursor) {
      setCursorStack((s) => [...s, cursor ?? ""]);
      setCursor(data.nextCursor);
    }
  };
  const goPrev = () => {
    setCursorStack((s) => {
      const next = [...s];
      const prev = next.pop();
      setCursor(prev || undefined);
      return next;
    });
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>近期任务</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : rows.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>智能体</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>时长</TableHead>
                    <TableHead>Token</TableHead>
                    <TableHead>工具/模型</TableHead>
                    <TableHead>时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((t) => (
                    <TableRow
                      key={t.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedId(t.id)}
                    >
                      <TableCell>
                        <AgentIdentity
                          name={t.agentName}
                          avatar={t.agentAvatar}
                        />
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusBadgeVariant(t.status)}>
                          {t.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDuration(t.durationMs)}</TableCell>
                      <TableCell>{formatNumber(t.totalTokens)}</TableCell>
                      <TableCell>
                        {t.toolCallCount ?? 0}/{t.modelCallCount ?? 0}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTime(t.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="mt-4 flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cursorStack.length === 0}
                  onClick={goPrev}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!data?.nextCursor}
                  onClick={goNext}
                >
                  下一页
                </Button>
              </div>
            </>
          ) : (
            <EmptyState />
          )}
        </CardContent>
      </Card>

      <TaskDetailSheet
        taskId={selectedId}
        onClose={() => setSelectedId(null)}
      />
    </>
  );
}
