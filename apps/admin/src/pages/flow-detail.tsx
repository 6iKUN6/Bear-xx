import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  GitBranch,
  Loader2,
  Pencil,
  ScanSearch,
  Rocket,
  Save,
  Undo2,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FlowCanvas } from "@/components/flow-canvas";
import { FlowMetadataSheet } from "@/components/flow-metadata-sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentFlow, useAgentFlowMutations } from "@/hooks/queries";
import {
  describeApiError,
  formatDefinition,
  parseDefinition,
  versionStatusMeta,
} from "@/lib/flow-meta";
import { formatTime } from "@/lib/format";
import { exportFlowVersion } from "@/api/endpoints";
import { confirm } from "@/components/confirm-dialog";
import type { AgentFlowValidation, AgentFlowVersion } from "@/api/types";

export function FlowDetailPage() {
  const { flowId } = useParams<{ flowId: string }>();
  const { data: flow, isLoading } = useAgentFlow(flowId);
  const { saveDraft, validate, publish, importDefinition, rollback } =
    useAgentFlowMutations(flowId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [validation, setValidation] = useState<AgentFlowValidation | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [previewVersion, setPreviewVersion] =
    useState<AgentFlowVersion | null>(null);

  const versions = flow?.versions ?? [];
  // 默认落在草稿上——那是唯一可编辑的版本
  const selected = useMemo(() => {
    if (selectedId) {
      return versions.find((v) => v.id === selectedId) ?? null;
    }
    return (
      versions.find((v) => v.status === "DRAFT") ??
      versions.find((v) => v.status === "PUBLISHED") ??
      versions[0] ??
      null
    );
  }, [selectedId, versions]);

  // updatedAt 进 key：保存成功后服务端返回的规范化 Definition 要回灌编辑器
  const selectedKey = selected ? `${selected.id}:${selected.updatedAt}` : null;
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  // 渲染期同步派生状态而非用 effect：避免先渲染一帧旧文本再被覆盖
  if (selected && selectedKey !== syncedKey) {
    setSyncedKey(selectedKey);
    setText(formatDefinition(selected.definition));
    setValidation(null);
  }

  // 契约不兼容的存量版本：服务端一定拒绝保存/校验/发布，可点即等于让用户白点一次收 400
  const incompatible = Boolean(selected && !selected.schemaCompatible);
  const isDraft = selected?.status === "DRAFT" && !incompatible;
  const dirty = Boolean(
    selected && text !== formatDefinition(selected.definition),
  );

  const parsed = parseDefinition(text);

  const handleSave = async () => {
    if (!selected || !parsed.ok) {
      toast.error(parsed.ok ? "没有可保存的版本" : parsed.error);
      return;
    }
    try {
      await saveDraft.mutateAsync({
        versionId: selected.id,
        definition: parsed.value,
      });
      setValidation(null);
      toast.success("草稿已保存");
    } catch (err) {
      toast.error(describeApiError(err, "保存失败"));
    }
  };

  const handleValidate = async () => {
    if (!selected) return;
    try {
      const result = await validate.mutateAsync(selected.id);
      setValidation(result);
      if (result.valid) {
        toast.success("校验通过");
      } else {
        toast.error(`校验未通过：${result.errors.length} 处问题`);
      }
    } catch (err) {
      toast.error(describeApiError(err, "校验失败"));
    }
  };

  const handlePublish = async () => {
    if (!selected) return;
    if (
      !(await confirm({
        title: "发布版本",
        description: `发布 v${selected.version}？当前发布版本会被归档。`,
        confirmText: "发布",
      }))
    )
      return;
    try {
      await publish.mutateAsync(selected.id);
      setSelectedId(null);
      toast.success(`v${selected.version} 已发布`);
    } catch (err) {
      toast.error(describeApiError(err, "发布失败"));
    }
  };

  const handleRollback = async (version: AgentFlowVersion) => {
    if (!flowId) return;
    if (
      !(await confirm({
        title: "回滚版本",
        description: `回滚到 v${version.version}？当前发布版本会被归档。`,
        confirmText: "回滚",
        danger: true,
      }))
    )
      return;
    try {
      await rollback.mutateAsync({ flowId, versionId: version.id });
      setSelectedId(null);
      toast.success(`已回滚到 v${version.version}`);
    } catch (err) {
      toast.error(describeApiError(err, "回滚失败"));
    }
  };

  /** 以当前版本内容为起点开一份新草稿：已发布版本不可编辑，这是唯一的改法 */
  const handleFork = async () => {
    if (!flowId || !parsed.ok) {
      toast.error(parsed.ok ? "缺少 Flow" : parsed.error);
      return;
    }
    try {
      const draft = await importDefinition.mutateAsync({
        flowId,
        definition: parsed.value,
      });
      setSelectedId(draft.id);
      toast.success(`已创建草稿 v${draft.version}`);
    } catch (err) {
      toast.error(describeApiError(err, "创建草稿失败"));
    }
  };

  const handleExport = async () => {
    if (!selected || !flow) return;
    try {
      const definition = await exportFlowVersion(selected.id);
      const blob = new Blob([JSON.stringify(definition, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${flow.name}-v${selected.version}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(describeApiError(err, "导出失败"));
    }
  };

  if (isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }
  if (!flow) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Flow 不存在或已被删除。
          <Button variant="link" asChild>
            <Link to="/flows">返回列表</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <FlowMetadataSheet
        flow={flow}
        open={metadataOpen}
        onClose={() => setMetadataOpen(false)}
      />
      <Dialog
        open={Boolean(previewVersion)}
        onOpenChange={(open) => !open && setPreviewVersion(null)}
      >
        <DialogContent className="flex h-[82vh] w-[92vw] max-w-[92vw] flex-col">
          <div className="shrink-0">
            <DialogTitle>
              v{previewVersion?.version} 结构预览
            </DialogTitle>
            <DialogDescription>
              {previewVersion
                ? versionStatusMeta(previewVersion.status).name
                : "只读画布"}
            </DialogDescription>
          </div>
          {previewVersion ? (
            <div className="min-h-0 flex-1">
              <FlowCanvas
                definition={previewVersion.definition}
                fitViewKey={previewVersion.id}
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/flows">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-foreground">{flow.name}</h1>
          <p className="text-xs text-muted-foreground">
            {flow.description || "无描述"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setMetadataOpen(true)}
          disabled={flow.id === "builtin-direct-flow"}
          title={
            flow.id === "builtin-direct-flow"
              ? "内置 Flow 由系统维护"
              : "编辑名称与描述"
          }
        >
          <Pencil className="h-4 w-4" />
          编辑基本信息
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>版本历史</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>digest</TableHead>
                <TableHead>发布时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((version) => {
                const meta = versionStatusMeta(version.status);
                const active = selected?.id === version.id;
                const canRollback =
                  version.status === "ARCHIVED" ||
                  (version.status === "PUBLISHED" &&
                    flow.publishedVersionId !== version.id);
                return (
                  <TableRow
                    key={version.id}
                    className={active ? "bg-muted/50" : undefined}
                  >
                    <TableCell>
                      <button
                        type="button"
                        className="font-medium text-foreground hover:underline"
                        onClick={() => setSelectedId(version.id)}
                      >
                        v{version.version}
                      </button>
                    </TableCell>
                    <TableCell className="space-x-1">
                      <Badge variant={meta.variant} title={meta.desc}>
                        {meta.name}
                      </Badge>
                      {version.schemaCompatible ? null : (
                        <Badge
                          variant="warning"
                          title="工件不符合当前 Definition 契约，无法编辑或发布"
                        >
                          契约不兼容
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground">
                        {version.digest ? `${version.digest.slice(0, 12)}…` : "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {version.publishedAt
                        ? formatTime(version.publishedAt)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {version.status === "DRAFT" &&
                      version.schemaCompatible ? (
                        <Button variant="ghost" size="sm" asChild>
                          <Link
                            to={`/flows/${flow.id}/versions/${version.id}/edit`}
                          >
                            <GitBranch className="h-4 w-4" />
                            编辑画布
                          </Link>
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPreviewVersion(version)}
                        >
                          <ScanSearch className="h-4 w-4" />
                          预览结构
                        </Button>
                      )}
                      {canRollback ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRollback(version)}
                          disabled={rollback.isPending}
                        >
                          <Undo2 className="h-4 w-4" />
                          回滚
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selected ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2">
              v{selected.version} FlowDefinition
              {isDraft ? null : (
                <Badge variant="outline">只读</Badge>
              )}
              {dirty ? <Badge variant="warning">未保存</Badge> : null}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Download className="h-4 w-4" />
                导出
              </Button>
              {isDraft ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSave}
                    disabled={!dirty || !parsed.ok || saveDraft.isPending}
                  >
                    {saveDraft.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    保存
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleValidate}
                    // 服务端校验的是已保存的版本，草稿脏着校验只会给出过时结论
                    title={dirty ? "先保存：校验针对已保存的版本" : undefined}
                    disabled={dirty || validate.isPending}
                  >
                    {validate.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    校验
                  </Button>
                  <Button
                    size="sm"
                    onClick={handlePublish}
                    disabled={dirty || publish.isPending}
                    title={dirty ? "先保存再发布" : undefined}
                  >
                    {publish.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Rocket className="h-4 w-4" />
                    )}
                    发布
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  onClick={handleFork}
                  disabled={importDefinition.isPending}
                  title="已发布与已归档版本不可编辑，以当前内容开一份新草稿"
                >
                  {importDefinition.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <GitBranch className="h-4 w-4" />
                  )}
                  另存为草稿
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              readOnly={!isDraft}
              spellCheck={false}
              className="min-h-[420px] font-mono text-xs leading-relaxed"
            />
            {!parsed.ok ? (
              <p className="text-xs text-[var(--lb-danger)]">
                JSON 语法错误：{parsed.error}
              </p>
            ) : null}
            {validation ? (
              validation.valid ? (
                <p className="text-xs text-[var(--lb-success)]">
                  校验通过 · digest {validation.digest?.slice(0, 16)}…
                </p>
              ) : (
                <div className="space-y-1 rounded-md border border-border p-3">
                  <p className="text-xs font-medium text-[var(--lb-danger)]">
                    {validation.errors.length} 处问题
                  </p>
                  {validation.errors.map((error, index) => (
                    <p
                      key={`${error.path}-${error.rule}-${index}`}
                      className="text-xs text-muted-foreground"
                    >
                      <span className="font-mono text-foreground">
                        {error.path}
                      </span>{" "}
                      <span className="font-mono">[{error.rule}]</span>{" "}
                      {error.message}
                    </p>
                  ))}
                </div>
              )
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            这个 Flow 还没有任何版本。
          </CardContent>
        </Card>
      )}
    </div>
  );
}
