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
import { EmptyState } from "@/components/kpi-card";
import { FlowCreateDialog } from "@/components/flow-create-dialog";
import {
  useAgentFlowMutations,
  useAgentFlowTemplates,
  useAgentFlows,
} from "@/hooks/queries";
import { describeApiError, versionStatusMeta } from "@/lib/flow-meta";
import { formatTime } from "@/lib/format";
import type { AgentFlow, AgentFlowTemplate } from "@/api/types";

export function FlowsPage() {
  const { data, isLoading } = useAgentFlows();
  const { data: templates } = useAgentFlowTemplates();
  const { create, remove } = useAgentFlowMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // 用本地集合而非 mutation.variables：后者是整个 hook 共享的，批量删除时
  // 只会反映最后一次调用，前面几行的 spinner 会提前消失
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const rows = data ?? [];

  const handleCreate = async (template: AgentFlowTemplate) => {
    try {
      await create.mutateAsync(template.definition);
      toast.success(`已从「${template.name}」创建草稿`);
      setCreateOpen(false);
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
    if (!window.confirm(`确定删除「${flow.name}」及其全部版本？`)) return;
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
      !window.confirm(`确定删除选中的 ${targets.length} 个 Flow 及其全部版本？`)
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
      <FlowCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        templates={templates ?? []}
        creating={create.isPending}
        onCreate={handleCreate}
      />
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Flow 编排</CardTitle>
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
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : rows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
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
                  </TableHead>
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
                  const removing = removingIds.has(flow.id);
                  return (
                    <TableRow key={flow.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`选择 ${flow.name}`}
                          className="align-middle"
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
                      </TableCell>
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
                          <Badge
                            variant="warning"
                            title="发布后才能被智能体绑定运行"
                          >
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
            <EmptyState text="还没有 Flow，点右上角「新建」选一个起点" />
          )}
        </CardContent>
      </Card>
    </>
  );
}
