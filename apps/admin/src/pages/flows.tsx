import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
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
import { FlowCreateDialog } from "@/components/flow-create-dialog";
import { FlowMetadataSheet } from "@/components/flow-metadata-sheet";
import {
  useAgentFlowMutations,
  useAgentFlowTemplates,
  useAgentFlows,
} from "@/hooks/queries";
import { describeApiError, versionStatusMeta } from "@/lib/flow-meta";
import { formatTime } from "@/lib/format";
import { confirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import type { AgentFlow } from "@/api/types";
import type { FlowCreateIntent } from "@/lib/flow-create";

export function FlowsPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useAgentFlows();
  const { data: templates } = useAgentFlowTemplates();
  const { create, remove, inspectDefinition } = useAgentFlowMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingFlow, setEditingFlow] = useState<AgentFlow | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // 用本地集合而非 mutation.variables：后者是整个 hook 共享的，批量删除时
  // 只会反映最后一次调用，前面几行的 spinner 会提前消失
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const rows = data ?? [];

  /**
   * 以模板或导入 JSON 创建 Flow
   * @param definition 已覆盖顶层名称和描述的完整 Definition
   * @param intent 创建后留在列表或直接进入新草稿画布
   * @returns 创建和可选跳转完成后的 Promise
   * @description 后端在同一事务返回逻辑 Flow 与首个草稿，跳转不再额外查询或猜测版本。
   */
  const handleCreate = async (
    definition: object,
    intent: FlowCreateIntent,
  ): Promise<void> => {
    try {
      const created = await create.mutateAsync(definition);
      toast.success(`已创建「${created.name}」草稿`);
      setCreateOpen(false);
      if (intent === "create-and-edit") {
        navigate(
          `/flows/${created.id}/versions/${created.draftVersion.id}/edit`,
        );
      }
    } catch (err) {
      // 失败时保持弹窗打开：关掉会让用户丢掉刚才的选择，还得重新选一遍
      toast.error(describeApiError(err, "创建失败"));
    }
  };

  const withRemoving = async (id: string, run: () => Promise<void>) => {
    setRemovingIds((current) => new Set(current).add(id));
    try {
      await run();
    } finally {
      setRemovingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDelete = async (flow: AgentFlow) => {
    if (
      !(await confirm({
        description: `确定删除「${flow.name}」及其全部版本？`,
        danger: true,
      }))
    )
      return;
    await withRemoving(flow.id, async () => {
      try {
        await remove.mutateAsync(flow.id);
        toast.success("已删除");
      } catch (err) {
        // 跑过任务或仍被智能体绑定时服务端会拒绝并说明原因，原样透出
        toast.error(describeApiError(err, "删除失败"));
      }
    });
  };

  /**
   * 批量删除选中的 Flow
   * @description 逐个调用单删端点而不是加一个批量端点：每个 Flow 的删除都有各自的业务门禁
   * （跑过任务、仍被智能体绑定），部分失败是常态。批量端点得先定义部分失败的语义，
   * 而逐个删 + 按条报告更诚实。
   * 串行而非并发：这些删除都带可串行化事务，并发只会制造无谓的序列化冲突重试。
   */
  const handleBatchDelete = async () => {
    const targets = rows.filter((flow) => selected.has(flow.id));
    if (targets.length === 0) return;
    if (
      !(await confirm({
        description: `确定删除选中的 ${targets.length} 个 Flow 及其全部版本？`,
        danger: true,
      }))
    ) {
      return;
    }
    const failures: Array<{ name: string; reason: string }> = [];
    let removed = 0;
    for (const flow of targets) {
      await withRemoving(flow.id, async () => {
        try {
          await remove.mutateAsync(flow.id);
          removed += 1;
          setSelected((current) => {
            const next = new Set(current);
            next.delete(flow.id);
            return next;
          });
        } catch (err) {
          failures.push({
            name: flow.name,
            reason: describeApiError(err, "删除失败"),
          });
        }
      });
    }
    // 不用一句「批量删除完成」盖住失败项：被拒的每一个都要说清是哪个、为什么
    if (removed > 0) {
      toast.success(`已删除 ${removed} 个 Flow`);
    }
    for (const failure of failures) {
      toast.error(`「${failure.name}」未删除：${failure.reason}`);
    }
  };

  return (
    <>
      {createOpen ? (
        <FlowCreateDialog
          open
          onOpenChange={setCreateOpen}
          templates={templates ?? []}
          creating={create.isPending}
          onInspect={(definition) => inspectDefinition.mutateAsync(definition)}
          onCreate={handleCreate}
        />
      ) : null}
      <FlowMetadataSheet
        flow={editingFlow}
        open={Boolean(editingFlow)}
        onClose={() => setEditingFlow(null)}
      />
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-foreground">Flow 编排</h1>
          {rows.length > 0 ? (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                aria-label="全选"
                className="align-middle"
                checked={selected.size === rows.length && rows.length > 0}
                // 部分选中显示为半选，避免看起来像"没选"
                ref={(element) => {
                  if (element) {
                    element.indeterminate =
                      selected.size > 0 && selected.size < rows.length;
                  }
                }}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? new Set(rows.map((flow) => flow.id))
                      : new Set(),
                  )
                }
              />
              全选
            </label>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="text-[var(--lb-danger)]"
              onClick={handleBatchDelete}
              disabled={removingIds.size > 0}
            >
              {removingIds.size > 0 ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              删除选中 {selected.size} 个
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            新建
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length > 0 ? (
        <EntityCardGrid>
          {rows.map((flow) => {
            const published = flow.publishedVersion;
            const status = published
              ? versionStatusMeta(published.status)
              : null;
            const removing = removingIds.has(flow.id);
            return (
              <EntityCard
                key={flow.id}
                className={cn(
                  selected.has(flow.id) && "border-primary ring-1 ring-primary",
                )}
              >
                <div className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${flow.name}`}
                    className="mt-1 shrink-0 align-middle"
                    checked={selected.has(flow.id)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) {
                          next.add(flow.id);
                        } else {
                          next.delete(flow.id);
                        }
                        return next;
                      })
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/flows/${flow.id}`}
                      className="block truncate font-medium text-foreground hover:underline"
                    >
                      {flow.name}
                    </Link>
                    {flow.description ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {flow.description}
                      </p>
                    ) : null}
                  </div>
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
                </div>

                <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="font-mono">
                    {published?.digest
                      ? `${published.digest.slice(0, 12)}…`
                      : "—"}
                  </span>
                  <span className="ml-auto">{formatTime(flow.updatedAt)}</span>
                </div>

                <EntityCardFooter>
                  <span />
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" asChild>
                      <Link to={`/flows/${flow.id}`}>版本与编辑</Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="编辑名称与描述"
                      onClick={() => setEditingFlow(flow)}
                      disabled={flow.id === "builtin-direct-flow"}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="删除"
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
                </EntityCardFooter>
              </EntityCard>
            );
          })}
        </EntityCardGrid>
      ) : (
        <EmptyState text="还没有 Flow，点右上角「新建」选一个起点" />
      )}
    </>
  );
}
