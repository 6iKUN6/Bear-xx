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
import { ModelPresetFormSheet } from "@/components/model-preset-form-sheet";
import { useModelPresets, useModelPresetMutations } from "@/hooks/queries";
import { ApiError } from "@/api/client";
import type { ModelPreset } from "@/api/types";

export function ModelsPage() {
  const { data, isLoading } = useModelPresets();
  const { remove } = useModelPresetMutations();
  const [editing, setEditing] = useState<ModelPreset | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

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
                  <TableHead>provider / platform</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>密钥</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium">
                        {p.name}
                        {p.isDefault ? (
                          <Badge variant="secondary">默认</Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {p.presetId}
                      </p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.provider} / {p.platform}
                    </TableCell>
                    <TableCell>{p.model}</TableCell>
                    <TableCell>
                      <Badge variant={p.apiKeyConfigured ? "success" : "warning"}>
                        {p.apiKeyConfigured ? "env 已配置" : "env 未配置"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.enabled ? "success" : "secondary"}>
                        {p.enabled ? "启用" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
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
                ))}
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
