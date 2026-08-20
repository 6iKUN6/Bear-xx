import { useState } from "react";
import { Loader2, Pencil, Plus, Trash2, Zap } from "lucide-react";
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
import { ModelPresetFormSheet } from "@/components/model-preset-form-sheet";
import { useModelPresets, useModelPresetMutations } from "@/hooks/queries";
import { capabilityMeta, upstreamFormatName } from "@/lib/model-preset-meta";
import { formatTime } from "@/lib/format";
import { ApiError } from "@/api/client";
import type { ModelPreset } from "@/api/types";

export function ModelsPage() {
  const { data, isLoading } = useModelPresets();
  const { remove, probe } = useModelPresetMutations();
  const [editing, setEditing] = useState<ModelPreset | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // 用本地集合而非 mutation.variables：后者是整个 hook 共享的，同时探测多行时
  // 先发起的那行会被后来者顶掉，spinner 提前消失但请求其实还在飞
  const [probingIds, setProbingIds] = useState<ReadonlySet<string>>(new Set());

  const rows = data ?? [];

  const openCreate = () => {
    setEditing(null);
    setSheetOpen(true);
  };
  const openEdit = (p: ModelPreset) => {
    setEditing(p);
    setSheetOpen(true);
  };

  const handleDelete = async (p: ModelPreset) => {
    if (p.isDefault) {
      toast.error("默认预设不可删除");
      return;
    }
    if (!window.confirm(`确定删除「${p.name}」？`)) return;
    try {
      await remove.mutateAsync(p.id);
      toast.success("已删除");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  const markProbing = (id: string, running: boolean) =>
    setProbingIds((ids) => {
      const next = new Set(ids);
      if (running) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleProbe = async (p: ModelPreset) => {
    markProbing(p.id, true);
    try {
      const result = await probe.mutateAsync(p.id);
      const detail = result.error ? `：${result.error}` : "";
      if (result.capability === "tools") {
        toast.success(`「${p.name}」工具往返已跑通`);
      } else if (result.capability === "basic") {
        // 不用 success：能对话不等于能用，带工具的节点仍会在发布期被拦下
        toast.warning(`「${p.name}」只能用于无工具节点${detail}`);
      } else {
        toast.error(`「${p.name}」连接失败${detail}`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "探测失败");
    } finally {
      markProbing(p.id, false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>模型预设</CardTitle>
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
                  <TableHead>名称 / presetId</TableHead>
                  <TableHead>上游格式 / platform</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>密钥</TableHead>
                  <TableHead>能力档位</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => {
                  const cap = capabilityMeta(p.capability);
                  const probing = probingIds.has(p.id);
                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex items-center gap-2 font-medium">
                          {p.name}
                          {p.isDefault ? (
                            <Badge variant="secondary">默认</Badge>
                          ) : null}
                          {p.enabled ? null : (
                            <Badge variant="secondary">停用</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {p.presetId}
                        </p>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          {upstreamFormatName(p.upstreamFormat)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {p.platform}
                        </p>
                      </TableCell>
                      <TableCell>{p.model}</TableCell>
                      <TableCell>
                        {p.apiKeyConfigured ? (
                          <span className="text-xs text-muted-foreground">
                            {p.apiKeyHint ?? "已配置"}
                          </span>
                        ) : (
                          <Badge variant="destructive">未配置</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={cap.variant} title={cap.desc}>
                          {cap.name}
                        </Badge>
                        {p.lastCheckError ? (
                          <p
                            className="max-w-[220px] truncate text-xs text-[var(--lb-danger)]"
                            title={p.lastCheckError}
                          >
                            {p.lastCheckError}
                          </p>
                        ) : p.lastCheckedAt ? (
                          <p className="text-xs text-muted-foreground">
                            {formatTime(p.lastCheckedAt)}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title={
                              p.apiKeyConfigured
                                ? "测试连接（使用已存密钥）"
                                : "未配置 apiKey，无法测试"
                            }
                            onClick={() => handleProbe(p)}
                            disabled={!p.apiKeyConfigured || probing}
                          >
                            {probing ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Zap className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEdit(p)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(p)}
                            disabled={p.isDefault}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState text="还没有模型预设，点击右上角新建" />
          )}
        </CardContent>
      </Card>

      <ModelPresetFormSheet
        preset={editing}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}
