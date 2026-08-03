import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
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
import { EmptyState } from "@/components/kpi-card";
import { AgentFormSheet } from "@/components/agent-form-sheet";
import { useAgents, useAgentMutations } from "@/hooks/queries";
import { ApiError } from "@/api/client";
import type { Agent } from "@/api/types";
import { strategyName, toolGroupName } from "@/lib/agent-meta";
import defaultAgentAvatar from "@litter-bear/assets/agents/default-avatar.png";

export function AgentManagePage() {
  const { data, isLoading } = useAgents();
  const { remove } = useAgentMutations();
  const [editing, setEditing] = useState<Agent | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const rows = data ?? [];

  const openCreate = () => {
    setEditing(null);
    setSheetOpen(true);
  };
  const openEdit = (agent: Agent) => {
    setEditing(agent);
    setSheetOpen(true);
  };

  const handleDelete = async (agent: Agent) => {
    if (agent.isDefault) {
      toast.error("默认智能体不可删除");
      return;
    }
    if (!window.confirm(`确定删除「${agent.name}」？`)) return;
    try {
      await remove.mutateAsync(agent.id);
      toast.success("已删除");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>智能体管理</CardTitle>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新建
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : rows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>策略</TableHead>
                  <TableHead>工具组</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <img
                          src={a.avatar || defaultAgentAvatar}
                          alt={a.name}
                          className="h-9 w-9 shrink-0 rounded-full border border-border bg-muted object-cover"
                          onError={(e) => {
                            (e.target as HTMLImageElement).src =
                              defaultAgentAvatar;
                          }}
                        />
                        <div>
                          <div className="flex items-center gap-2 font-medium">
                            {a.name}
                            {a.isDefault ? (
                              <Badge variant="secondary">默认</Badge>
                            ) : null}
                          </div>
                          {a.description ? (
                            <p className="text-xs text-muted-foreground">
                              {a.description}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {strategyName(a.defaultStrategy)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {a.toolGroups.length
                        ? a.toolGroups.map(toolGroupName).join("、")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={a.enabled ? "success" : "secondary"}>
                        {a.enabled ? "启用" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(a)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(a)}
                          disabled={a.isDefault}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState text="还没有智能体，点击右上角新建" />
          )}
        </CardContent>
      </Card>

      <AgentFormSheet
        agent={editing}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}
