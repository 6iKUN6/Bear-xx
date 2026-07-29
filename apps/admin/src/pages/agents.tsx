import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/kpi-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentUsage } from "@/hooks/queries";
import { useUiStore } from "@/stores/ui-store";
import { chartColors, formatDuration, formatPercent } from "@/lib/format";

export function AgentsPage() {
  const days = useUiStore((s) => s.rangeDays);
  const { data, isLoading } = useAgentUsage(days);
  const rows = data ?? [];
  const colors = chartColors();

  const chartData = rows.map((r) => ({
    name: r.agentId ?? "默认",
    任务数: r.taskCount,
  }));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>各智能体任务量</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="任务数" fill={colors[0]} radius={0} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>智能体用量明细</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>智能体</TableHead>
                <TableHead>任务数</TableHead>
                <TableHead>完成数</TableHead>
                <TableHead>成功率</TableHead>
                <TableHead>平均时长</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.agentId ?? "default"}>
                  <TableCell className="font-medium">
                    {r.agentId ?? "默认智能体"}
                  </TableCell>
                  <TableCell>{r.taskCount}</TableCell>
                  <TableCell>{r.completedCount}</TableCell>
                  <TableCell>{formatPercent(r.successRate)}</TableCell>
                  <TableCell>{formatDuration(r.avgDurationMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isLoading && rows.length === 0 ? <EmptyState /> : null}
        </CardContent>
      </Card>
    </div>
  );
}
