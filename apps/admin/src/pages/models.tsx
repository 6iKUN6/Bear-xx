import { useState } from "react";
import { Loader2, Pencil, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import type {
  ModelPreset,
  ModelProviderConnection,
  ModelProviderTemplate,
} from "@/api/types";
import { ApiError } from "@/api/client";
import { confirm } from "@/components/confirm-dialog";
import {
  EntityCard,
  EntityCardFooter,
  EntityCardGrid,
} from "@/components/entity-card";
import { EmptyState } from "@/components/kpi-card";
import { ModelPresetFormSheet } from "@/components/model-preset-form-sheet";
import { ModelProviderConnectionSheet } from "@/components/model-provider-connection-sheet";
import { ModelProviderLogo } from "@/components/model-provider-logo";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useModelPresetMutations,
  useModelProviderConnectionMutations,
  useModelProviderConnections,
  useModelProviderTemplates,
} from "@/hooks/queries";
import { formatTime } from "@/lib/format";
import { capabilityMeta, upstreamFormatName } from "@/lib/model-preset-meta";
import { cn } from "@/lib/utils";

interface ModelEditorState {
  connection: ModelProviderConnection;
  preset: ModelPreset | null;
}

export function ModelsPage() {
  const templatesQuery = useModelProviderTemplates();
  const connectionsQuery = useModelProviderConnections();
  const connectionMutations = useModelProviderConnectionMutations();
  const presetMutations = useModelPresetMutations();
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [connectionEditor, setConnectionEditor] = useState<{
    template: ModelProviderTemplate;
    connection: ModelProviderConnection | null;
  }>();
  const [modelEditor, setModelEditor] = useState<ModelEditorState>();
  const [detailConnectionId, setDetailConnectionId] = useState<string | null>(
    null,
  );
  const [probingConnectionIds, setProbingConnectionIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [probingModelIds, setProbingModelIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const templates = templatesQuery.data ?? [];
  const connections = connectionsQuery.data ?? [];
  const allPresets = connections.flatMap((connection) =>
    connection.models.map((preset) => ({ connection, preset })),
  );
  const detailConnection = detailConnectionId
    ? connections.find((connection) => connection.id === detailConnectionId)
    : undefined;
  const modelEditorTemplate = modelEditor
    ? templates.find(
        (template) => template.providerKey === modelEditor.connection.providerKey,
      )
    : undefined;
  const loading = templatesQuery.isLoading || connectionsQuery.isLoading;
  const error = templatesQuery.error ?? connectionsQuery.error;

  const markRunning = (
    setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
    id: string,
    running: boolean,
  ) =>
    setter((ids) => {
      const next = new Set(ids);
      if (running) next.add(id);
      else next.delete(id);
      return next;
    });

  const probeConnection = async (connection: ModelProviderConnection) => {
    const model = connection.models.find((item) => item.enabled);
    if (!model) {
      toast.error("该连接没有可用于测试的启用模型");
      return;
    }
    markRunning(setProbingConnectionIds, connection.id, true);
    try {
      const result = await connectionMutations.probe.mutateAsync({
        id: connection.id,
        modelPresetId: model.id,
      });
      if (result.reachable) {
        toast.success(`「${connection.name}」基础连接正常`);
      } else {
        toast.error(
          `「${connection.name}」连接失败${result.error ? `：${result.error}` : ""}`,
        );
      }
    } catch (probeError) {
      toast.error(
        probeError instanceof ApiError ? probeError.message : "连接测试失败",
      );
    } finally {
      markRunning(setProbingConnectionIds, connection.id, false);
    }
  };

  const probeModel = async (preset: ModelPreset) => {
    markRunning(setProbingModelIds, preset.id, true);
    try {
      const result = await presetMutations.probe.mutateAsync(preset.id);
      const detail = result.error ? `：${result.error}` : "";
      if (result.capability === "tools") {
        toast.success(`「${preset.name}」工具往返已跑通`);
      } else if (result.capability === "basic") {
        toast.warning(`「${preset.name}」只能用于无工具节点${detail}`);
      } else {
        toast.error(`「${preset.name}」连接失败${detail}`);
      }
    } catch (probeError) {
      toast.error(
        probeError instanceof ApiError ? probeError.message : "能力探测失败",
      );
    } finally {
      markRunning(setProbingModelIds, preset.id, false);
    }
  };

  const deleteModel = async (preset: ModelPreset) => {
    if (preset.isDefault) {
      toast.error("系统默认模型不可删除");
      return;
    }
    if (
      !(await confirm({
        description: `确定删除模型「${preset.name}」？若仍被 Agent 或 Flow 引用，服务端会拒绝。`,
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await presetMutations.remove.mutateAsync(preset.id);
      toast.success("模型已删除");
    } catch (removeError) {
      toast.error(
        removeError instanceof ApiError ? removeError.message : "删除失败",
      );
    }
  };

  const deleteConnection = async (connection: ModelProviderConnection) => {
    if (connection.models.length > 0) {
      toast.error("请先处理并删除连接下的模型");
      return;
    }
    if (
      !(await confirm({
        description: `确定删除空连接「${connection.name}」？`,
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await connectionMutations.remove.mutateAsync(connection.id);
      toast.success("连接已删除");
      setDetailConnectionId((id) => (id === connection.id ? null : id));
    } catch (removeError) {
      toast.error(
        removeError instanceof ApiError ? removeError.message : "删除失败",
      );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">模型预设</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            一份供应商连接共享给多个模型，Flow 始终绑定具体模型预设。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            title="刷新供应商连接"
            onClick={() => void connectionsQuery.refetch()}
            disabled={connectionsQuery.isFetching}
          >
            <RefreshCw
              className={cn(
                "h-4 w-4",
                connectionsQuery.isFetching && "animate-spin",
              )}
            />
          </Button>
          <Button size="sm" onClick={() => setProviderPickerOpen(true)}>
            <Plus className="h-4 w-4" />
            添加连接
          </Button>
        </div>
      </div>

      {loading ? (
        <PresetGridSkeleton />
      ) : error ? (
        <div className="flex min-h-52 flex-col items-center justify-center gap-3 border-y border-border text-center">
          <p className="font-medium text-foreground">模型预设加载失败</p>
          <p className="max-w-lg text-sm text-muted-foreground">
            {error instanceof ApiError ? error.message : "请检查 API 服务状态"}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void templatesQuery.refetch();
              void connectionsQuery.refetch();
            }}
          >
            <RefreshCw className="h-4 w-4" />
            重试
          </Button>
        </div>
      ) : allPresets.length === 0 ? (
        <EmptyState text="还没有模型预设，点击右上角「添加连接」创建" />
      ) : (
        <EntityCardGrid>
          {allPresets.map(({ connection, preset }) => (
            <PresetCard
              key={preset.id}
              connection={connection}
              preset={preset}
              probing={probingModelIds.has(preset.id)}
              onOpenDetail={() => setDetailConnectionId(connection.id)}
              onProbe={() => void probeModel(preset)}
              onEdit={() => setModelEditor({ connection, preset })}
              onDelete={() => void deleteModel(preset)}
            />
          ))}
        </EntityCardGrid>
      )}

      <ProviderPickerDialog
        open={providerPickerOpen}
        templates={templates}
        connections={connections}
        onClose={() => setProviderPickerOpen(false)}
        onSelect={(template) => {
          setProviderPickerOpen(false);
          setConnectionEditor({ template, connection: null });
        }}
      />

      {detailConnection ? (
        <ConnectionDetailDialog
          connection={detailConnection}
          probingConnection={probingConnectionIds.has(detailConnection.id)}
          probingModelIds={probingModelIds}
          onClose={() => setDetailConnectionId(null)}
          onProbeConnection={() => void probeConnection(detailConnection)}
          onEditConnection={() => {
            const template = templates.find(
              (item) => item.providerKey === detailConnection.providerKey,
            );
            if (!template) return;
            setConnectionEditor({ template, connection: detailConnection });
          }}
          onDeleteConnection={() => void deleteConnection(detailConnection)}
          onAddModel={() =>
            setModelEditor({ connection: detailConnection, preset: null })
          }
          onEditModel={(preset) =>
            setModelEditor({ connection: detailConnection, preset })
          }
          onProbeModel={(preset) => void probeModel(preset)}
          onDeleteModel={(preset) => void deleteModel(preset)}
        />
      ) : null}

      {connectionEditor ? (
        <ModelProviderConnectionSheet
          key={
            connectionEditor.connection?.id ??
            connectionEditor.template.providerKey
          }
          template={connectionEditor.template}
          connection={connectionEditor.connection}
          onClose={() => setConnectionEditor(undefined)}
        />
      ) : null}

      {modelEditor && modelEditorTemplate ? (
        <ModelPresetFormSheet
          key={modelEditor.preset?.id ?? `${modelEditor.connection.id}:new`}
          connection={modelEditor.connection}
          template={modelEditorTemplate}
          preset={modelEditor.preset}
          onClose={() => setModelEditor(undefined)}
        />
      ) : null}
    </div>
  );
}

/** 单个模型预设卡片：logo + 名称 + 状态 + 测试/编辑/删除；点卡片打开所属连接的详情弹层。 */
function PresetCard({
  connection,
  preset,
  probing,
  onOpenDetail,
  onProbe,
  onEdit,
  onDelete,
}: {
  connection: ModelProviderConnection;
  preset: ModelPreset;
  probing: boolean;
  onOpenDetail: () => void;
  onProbe: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const capability = capabilityMeta(preset.capability);
  const enabled = preset.enabled && connection.enabled;
  return (
    <EntityCard
      className="cursor-pointer"
      onClick={onOpenDetail}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail();
        }
      }}
    >
      <div className="flex items-start gap-3">
        <ModelProviderLogo
          providerKey={connection.providerKey}
          name={connection.name}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-medium">
            <span className="truncate">{preset.name}</span>
            {preset.isDefault ? (
              <Badge variant="secondary">系统默认</Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {preset.model}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge variant={capability.variant} title={capability.desc}>
          {capability.name}
        </Badge>
        <Badge variant={enabled ? "outline" : "secondary"}>
          {enabled ? "启用" : "停用"}
        </Badge>
      </div>

      <EntityCardFooter>
        <span className="truncate text-xs text-muted-foreground">
          {connection.name}
        </span>
        <div
          className="flex gap-1"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon"
            title="探测模型对话与工具能力"
            onClick={onProbe}
            disabled={!connection.enabled || !preset.enabled || probing}
          >
            {probing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
          </Button>
          <Button variant="ghost" size="icon" title="编辑模型" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="删除模型"
            onClick={onDelete}
            disabled={preset.isDefault}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </EntityCardFooter>
    </EntityCard>
  );
}

/** 「添加连接」第一步：在弹窗里选供应商类型，确认后再开连接表单 Sheet。 */
function ProviderPickerDialog({
  open,
  templates,
  connections,
  onClose,
  onSelect,
}: {
  open: boolean;
  templates: ModelProviderTemplate[];
  connections: ModelProviderConnection[];
  onClose: () => void;
  onSelect: (template: ModelProviderTemplate) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogTitle>选择模型供应商</DialogTitle>
        <DialogDescription>
          选择供应商类型，下一步配置连接地址、密钥与初始模型。
        </DialogDescription>
        <div className="grid grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
          {templates.map((template) => {
            const connectionCount = connections.filter(
              (connection) => connection.providerKey === template.providerKey,
            ).length;
            const providerConnections = connections.filter(
              (connection) => connection.providerKey === template.providerKey,
            );
            const modelCount = providerConnections.reduce(
              (total, connection) => total + connection.models.length,
              0,
            );
            const emptyConnectionCount = providerConnections.filter(
              (connection) => connection.models.length === 0,
            ).length;
            return (
              <button
                type="button"
                key={template.providerKey}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/50"
                onClick={() => onSelect(template)}
              >
                <ModelProviderLogo
                  providerKey={template.providerKey}
                  name={template.name}
                />
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {template.name}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {template.defaultBaseURL ?? "自定义 API 根地址"}
                  </p>
                  {connectionCount > 0 ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      <p>
                        {connectionCount} 个连接 · {modelCount} 个模型
                      </p>
                      {emptyConnectionCount > 0 ? (
                        <p>其中 {emptyConnectionCount} 个空连接</p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      尚未配置
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 连接详情弹层：连接信息与操作 + 其下模型表格，点卡片打开。 */
function ConnectionDetailDialog({
  connection,
  probingConnection,
  probingModelIds,
  onClose,
  onProbeConnection,
  onEditConnection,
  onDeleteConnection,
  onAddModel,
  onEditModel,
  onProbeModel,
  onDeleteModel,
}: {
  connection: ModelProviderConnection;
  probingConnection: boolean;
  probingModelIds: ReadonlySet<string>;
  onClose: () => void;
  onProbeConnection: () => void;
  onEditConnection: () => void;
  onDeleteConnection: () => void;
  onAddModel: () => void;
  onEditModel: (preset: ModelPreset) => void;
  onProbeModel: (preset: ModelPreset) => void;
  onDeleteModel: (preset: ModelPreset) => void;
}) {
  const connectionStatus = connectionStatusMeta(connection.status);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <div className="flex items-start gap-3 pr-8">
          <ModelProviderLogo
            providerKey={connection.providerKey}
            name={connection.name}
          />
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {connection.name}
              <Badge variant={connectionStatus.variant}>
                {connectionStatus.label}
              </Badge>
              {!connection.enabled ? (
                <Badge variant="secondary">已停用</Badge>
              ) : null}
            </DialogTitle>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {connection.baseURL}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {connection.apiKeyHint ?? "密钥已配置"} ·{" "}
              {connection.models.length} 个模型 ·{" "}
              {connection.agentReferenceCount} 个智能体引用 ·{" "}
              {connection.flowReferenceCount} 个 Flow 引用 ·{" "}
              {connection.taskReferenceCount} 个运行中任务
            </p>
            {connection.lastCheckError ? (
              <p className="mt-2 text-xs text-[var(--lb-danger)]">
                {connection.lastCheckError}
              </p>
            ) : connection.lastCheckedAt ? (
              <p className="mt-2 text-xs text-muted-foreground">
                最近连接测试 {formatTime(connection.lastCheckedAt)}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onProbeConnection}
            disabled={!connection.enabled || probingConnection}
          >
            {probingConnection ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            测试连接
          </Button>
          <Button size="sm" variant="outline" onClick={onEditConnection}>
            <Pencil className="h-4 w-4" />
            编辑连接
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDeleteConnection}
            disabled={connection.models.length > 0}
          >
            <Trash2 className="h-4 w-4" />
            删除连接
          </Button>
          <Button size="sm" className="sm:ml-auto" onClick={onAddModel}>
            <Plus className="h-4 w-4" />
            添加模型
          </Button>
        </div>

        <div className="min-h-0 overflow-y-auto">
          {connection.models.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead>协议</TableHead>
                  <TableHead>能力</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connection.models.map((preset) => {
                  const capability = capabilityMeta(preset.capability);
                  const probing = probingModelIds.has(preset.id);
                  return (
                    <TableRow key={preset.id}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-foreground">
                            {preset.name}
                          </span>
                          {preset.isDefault ? (
                            <Badge variant="secondary">系统默认</Badge>
                          ) : null}
                        </div>
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                          {preset.model}
                        </p>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {upstreamFormatName(preset.upstreamFormat)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={capability.variant}
                          title={capability.desc}
                        >
                          {capability.name}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {preset.enabled && connection.enabled ? (
                          <Badge variant="outline">启用</Badge>
                        ) : (
                          <Badge variant="secondary">停用</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="探测模型对话与工具能力"
                            onClick={() => onProbeModel(preset)}
                            disabled={
                              !connection.enabled || !preset.enabled || probing
                            }
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
                            title="编辑模型"
                            onClick={() => onEditModel(preset)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="删除模型"
                            onClick={() => onDeleteModel(preset)}
                            disabled={preset.isDefault}
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
            <div className="border-t border-border px-4 py-6 text-center text-sm text-muted-foreground">
              该连接还没有模型
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function connectionStatusMeta(status: ModelProviderConnection["status"]): {
  label: string;
  variant: BadgeProps["variant"];
} {
  if (status === "reachable") return { label: "连接正常", variant: "success" };
  if (status === "unreachable")
    return { label: "连接失败", variant: "destructive" };
  return { label: "未测试", variant: "secondary" };
}

function PresetGridSkeleton() {
  return (
    <EntityCardGrid>
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-36" />
      ))}
    </EntityCardGrid>
  );
}
