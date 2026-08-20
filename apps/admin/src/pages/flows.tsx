import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/kpi-card";
import {
  useAgentFlowMutations,
  useAgentFlowTemplates,
  useAgentFlows,
} from "@/hooks/queries";
import { versionStatusMeta } from "@/lib/flow-meta";
import { formatTime } from "@/lib/format";
import { ApiError } from "@/api/client";
import type { AgentFlow } from "@/api/types";

export function FlowsPage() {
  const { data, isLoading } = useAgentFlows();
  const { data: templates } = useAgentFlowTemplates();
  const { create, remove } = useAgentFlowMutations();
  const [preset, setPreset] = useState("");

  const rows = data ?? [];

  const handleCreate = async () => {
    const template = (templates ?? []).find((t) => t.preset === preset);
    if (!template) {
      toast.error("请选择一个内置模板作为起点");
      return;
    }
    try {
      await create.mutateAsync(template.definition);
      toast.success(`已从「${template.name}」创建草稿`);
      setPreset("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "创建失败");
    }
  };

  const handleDelete = async (flow: AgentFlow) => {
    if (!window.confirm(`确定删除「${flow.name}」及其全部版本？`)) return;
    try {
      await remove.mutateAsync(flow.id);
      toast.success("已删除");
    } catch (err) {
      // 跑过任务或仍被智能体绑定时服务端会拒绝并说明原因，原样透出
      toast.error(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Flow 编排</CardTitle>
        <div className="flex items-center gap-2">
          <div className="w-44">
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger className="h-8">
                <SelectValue placeholder="选择内置模板" />
              </SelectTrigger>
              <SelectContent>
                {(templates ?? []).map((t) => (
                  <SelectItem key={t.preset} value={t.preset}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={handleCreate} disabled={create.isPending}>
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            新建
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : rows.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>发布版本</TableHead>
                <TableHead>digest</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((flow) => {
                const published = flow.publishedVersion;
                const status = published
                  ? versionStatusMeta(published.status)
                  : null;
                const removing =
                  remove.isPending && remove.variables === flow.id;
                return (
                  <TableRow key={flow.id}>
                    <TableCell>
                      <Link
                        to={`/flows/${flow.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {flow.name}
                      </Link>
                      {flow.description ? (
                        <p className="max-w-[320px] truncate text-xs text-muted-foreground">
                          {flow.description}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {published && status ? (
                        <Badge variant={status.variant} title={status.desc}>
                          v{published.version} {status.name}
                        </Badge>
                      ) : (
                        // 没有发布版本 = 无法被智能体绑定 = 跑不起来，不能显示成中性状态
                        <Badge variant="warning" title="发布后才能被智能体绑定运行">
                          未发布
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">
                        {published?.digest
                          ? `${published.digest.slice(0, 12)}…`
                          : "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTime(flow.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/flows/${flow.id}`}>版本与编辑</Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(flow)}
                          disabled={removing}
                        >
                          {removing ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <EmptyState text="还没有 Flow，右上角选一个内置模板开始" />
        )}
      </CardContent>
    </Card>
  );
}
