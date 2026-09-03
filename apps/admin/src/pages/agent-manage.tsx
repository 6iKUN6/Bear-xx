import { useState } from "react";
import { Plus, Pencil, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/kpi-card";
import {
  EntityCard,
  EntityCardFooter,
  EntityCardGrid,
} from "@/components/entity-card";
import { AgentFormDialog } from "@/components/agent-form-dialog";
import { AgentAvatar } from "@/components/agent-identity";
import { useAgents, useAgentMutations } from "@/hooks/queries";
import { ApiError } from "@/api/client";
import type { Agent } from "@/api/types";
import { toolGroupName } from "@/lib/agent-meta";
import { confirm } from "@/components/confirm-dialog";

export function AgentManagePage() {
  const { data, isLoading } = useAgents();
  const { remove, setDefault } = useAgentMutations();
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
    if (!(await confirm({ description: `确定删除「${agent.name}」？`, danger: true }))) return;
    try {
      await remove.mutateAsync(agent.id);
      toast.success("已删除");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  const handleSetDefault = async (agent: Agent) => {
    if (
      !(await confirm({
        title: "设为默认智能体",
        description: `将「${agent.name}」设为默认回复智能体？未匹配到专属智能体的对话将改由它处理。`,
        confirmText: "设为默认",
      }))
    )
      return;
    try {
      await setDefault.mutateAsync(agent.id);
      toast.success("已设为默认回复智能体");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "设置失败");
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">智能体管理</h1>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新建
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length > 0 ? (
        <EntityCardGrid>
          {rows.map((a) => (
            <EntityCard key={a.id}>
              <div className="flex items-start gap-3">
                <AgentAvatar name={a.name} avatar={a.avatar} className="h-10 w-10" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 font-medium">
                    <span className="truncate">{a.name}</span>
                    {a.isDefault ? (
                      <Badge variant="secondary">默认回复</Badge>
                    ) : null}
                  </div>
                  {a.description ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {a.description}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {/* 绑定的 Flow 才是决定行为的东西；不展开图名是为了不给列表页
                    多加一次 Flow 列表请求，详情在编辑抽屉里 */}
                <Badge variant={a.defaultFlowVersionId ? "default" : "outline"}>
                  {a.defaultFlowVersionId ? "已绑定 Flow" : "内置直接回复"}
                </Badge>
                <Badge variant={a.enabled ? "success" : "secondary"}>
                  {a.enabled ? "启用" : "停用"}
                </Badge>
                <Badge variant={a.visible ? "outline" : "secondary"}>
                  {a.visible ? "展示" : "隐藏"}
                </Badge>
                <Badge
                  variant={a.minimumMembershipTier === "FREE" ? "outline" : "warning"}
                >
                  {a.minimumMembershipTier}
                </Badge>
              </div>

              <EntityCardFooter>
                <span className="truncate text-xs text-muted-foreground">
                  {a.toolGroups.length
                    ? a.toolGroups.map(toolGroupName).join("、")
                    : "无工具组"}
                </span>
                <div className="flex gap-1">
                  {!a.isDefault ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleSetDefault(a)}
                      disabled={
                        !a.enabled ||
                        !a.visible ||
                        a.minimumMembershipTier !== "FREE" ||
                        setDefault.isPending
                      }
                      title={
                        !a.enabled
                          ? "停用的智能体不可设为默认"
                          : !a.visible
                            ? "隐藏的智能体不可设为默认"
                            : a.minimumMembershipTier !== "FREE"
                              ? "默认智能体最低会员等级必须为 FREE"
                              : "设为默认回复智能体"
                      }
                      aria-label="设为默认回复智能体"
                    >
                      <Star className="h-4 w-4" />
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    title="编辑"
                    onClick={() => openEdit(a)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="删除"
                    onClick={() => handleDelete(a)}
                    disabled={a.isDefault}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </EntityCardFooter>
            </EntityCard>
          ))}
        </EntityCardGrid>
      ) : (
        <EmptyState text="还没有智能体，点击右上角新建" />
      )}

      <AgentFormDialog
        agent={editing}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}
