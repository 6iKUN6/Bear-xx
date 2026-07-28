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
import { useToolUsage } from "@/hooks/queries";
import { useUiStore } from "@/stores/ui-store";
import { chartColors, formatDuration, formatPercent } from "@/lib/format";

export function ToolsPage() {
  const days = useUiStore((s) => s.rangeDays);
  const { data, isLoading } = useToolUsage(days);
  const rows = data ?? [];
  const colors = chartColors();

  const chartData = rows.map((r) => ({
    name: r.toolName ?? "未知",
    调用次数: r.callCount,
  }));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>工具调用次数</CardTitle>
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
                <Bar dataKey="调用次数" fill={colors[1]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>工具调用明细</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>工具</TableHead>
                <TableHead>调用次数</TableHead>
                <TableHead>成功数</TableHead>
                <TableHead>成功率</TableHead>
                <TableHead>平均时长</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.toolName ?? "unknown"}>
                  <TableCell className="font-medium">
                    {r.toolName ?? "未知工具"}
                  </TableCell>
                  <TableCell>{r.callCount}</TableCell>
                  <TableCell>{r.successCount}</TableCell>
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
