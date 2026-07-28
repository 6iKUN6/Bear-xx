import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  getTaskErrorCategoryLabel,
  type TaskErrorCategory,
} from "@litter-bear/types/protocol";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/kpi-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useErrorBreakdown } from "@/hooks/queries";
import { useUiStore } from "@/stores/ui-store";
import { chartColors } from "@/lib/format";

export function ErrorsPage() {
  const days = useUiStore((s) => s.rangeDays);
  const { data, isLoading } = useErrorBreakdown(days);
  const colors = chartColors();

  const rows = (data ?? []).map((r) => ({
    name: getTaskErrorCategoryLabel(r.category as TaskErrorCategory),
    count: r.count,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>错误类别分布</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : rows.length > 0 ? (
          <ResponsiveContainer width="100%" height={320}>
            <PieChart>
              <Pie
                data={rows}
                dataKey="count"
                nameKey="name"
                outerRadius={120}
                label
              >
                {rows.map((_, i) => (
                  <Cell key={i} fill={colors[i % colors.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState text="窗口内暂无失败任务" />
        )}
      </CardContent>
    </Card>
  );
}
