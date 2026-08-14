import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard, EmptyState } from "@/components/kpi-card";
import { AgentIdentity } from "@/components/agent-identity";
import { useAgentUsage, useOverview, useToolUsage } from "@/hooks/queries";
import { useUiStore } from "@/stores/ui-store";
import {
  chartColors,
  formatDuration,
  formatNumber,
  formatPercent,
} from "@/lib/format";

export function DashboardPage() {
  const days = useUiStore((s) => s.rangeDays);
  const overview = useOverview(days);
  const tools = useToolUsage(days);
  const agents = useAgentUsage(days);
  const colors = chartColors();

  const o = overview.data;
  const topTools = (tools.data ?? []).slice(0, 5);
  const topAgents = (agents.data ?? []).slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="总任务"
          value={formatNumber(o?.totalTasks)}
          loading={overview.isLoading}
        />
        <KpiCard
          label="成功率"
          value={formatPercent(o?.successRate)}
          hint={o ? `完成 ${o.completedTasks} / 共 ${o.totalTasks}` : undefined}
          loading={overview.isLoading}
        />
        <KpiCard
          label="平均时长"
          value={formatDuration(o?.avgDurationMs)}
          loading={overview.isLoading}
        />
        <KpiCard
          label="失败数"
          value={formatNumber(o?.erroredTasks)}
          loading={overview.isLoading}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>任务状态分布</CardTitle>
          </CardHeader>
          <CardContent>
            {o && o.statusBreakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={o.statusBreakdown}
                    dataKey="count"
                    nameKey="status"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                  >
                    {o.statusBreakdown.map((_, i) => (
                      <Cell key={i} fill={colors[i % colors.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top 工具调用</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {topTools.length > 0 ? (
              topTools.map((t) => (
                <div key={t.toolName ?? "unknown"} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-foreground">
                      {t.toolName ?? "未知工具"}
                    </span>
                    <span className="text-muted-foreground">
                      {t.callCount} 次 · {formatPercent(t.successRate)}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{
                        width: `${Math.min(
                          100,
                          (t.callCount / (topTools[0].callCount || 1)) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <EmptyState />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top 智能体</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {topAgents.length > 0 ? (
            topAgents.map((a) => (
              <div
                key={a.agentId ?? "default"}
                className="rounded-md border border-border px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <AgentIdentity
                    name={a.agentName}
                    avatar={a.agentAvatar}
                    compact
                  />
                  <Badge variant="secondary">{a.taskCount} 任务</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  成功率 {formatPercent(a.successRate)} · 均时{" "}
                  {formatDuration(a.avgDurationMs)}
                </p>
              </div>
            ))
          ) : (
            <EmptyState />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
