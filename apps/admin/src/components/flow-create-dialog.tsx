import { useMemo, useState } from "react";
import {
  ArrowRight,
  FileJson,
  LayoutTemplate,
  Loader2,
  Plus,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  NODE_TYPE_ICONS,
  nodeTypeMeta,
  readDefinitionForCanvas,
  toFlowGraph,
} from "@/lib/flow-graph";
import type { FlowNodeType } from "@litter-bear/types/agent-flow";
import type { AgentFlowTemplate, FlowDefinitionInspection } from "@/api/types";
import {
  applyFlowCreationMetadata,
  parseFlowCreationJson,
  type FlowCreateIntent,
  type FlowCreationMetadata,
} from "@/lib/flow-create";

type FlowCreateMode = "template" | "json";

interface FlowCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: AgentFlowTemplate[];
  creating: boolean;
  onInspect: (definition: object) => Promise<FlowDefinitionInspection>;
  onCreate: (definition: object, intent: FlowCreateIntent) => Promise<void>;
}

/**
 * 新建 Flow 的起点选择弹窗
 * @param props 开关、模板列表、创建中状态与创建回调
 * @returns 返回弹窗
 * @description 每个选项都展示它**实际包含的节点链**，而不只是一句描述——「基于官方模板」如果
 * 看不到里面有什么，等于让人盲选。节点顺序取自画布投影的自动排布层级（同一层是并行分支），
 * 是从图算出来的，不是照着数组顺序假设的。
 * 选中再点创建，而不是点一下就建：草稿虽然可删，但误触会留下一堆待清理的记录。
 */
export function FlowCreateDialog({
  open,
  onOpenChange,
  templates,
  creating,
  onInspect,
  onCreate,
}: FlowCreateDialogProps) {
  const [mode, setMode] = useState<FlowCreateMode>("template");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [templateMetadata, setTemplateMetadata] =
    useState<FlowCreationMetadata>({ name: "", description: "" });
  const [jsonText, setJsonText] = useState("");
  const [jsonDefinition, setJsonDefinition] = useState<object | null>(null);
  const [jsonMetadata, setJsonMetadata] = useState<FlowCreationMetadata>({
    name: "",
    description: "",
  });
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonFileName, setJsonFileName] = useState<string | null>(null);
  const [jsonInspection, setJsonInspection] =
    useState<FlowDefinitionInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);

  // blank 排最前：从空白起步比从某个预设改起更常用。后端已经这样排，这里不再重排，
  // 只在缺失时兜底提示，避免前端和后端各有一套顺序
  const selected = useMemo(
    () => templates.find((item) => item.preset === selectedPreset) ?? null,
    [templates, selectedPreset],
  );

  const metadata = mode === "template" ? templateMetadata : jsonMetadata;
  const sourceDefinition =
    mode === "template" ? selected?.definition : jsonDefinition;
  const canCreate = Boolean(sourceDefinition && metadata.name.trim());

  /**
   * 清空弹窗内本轮创建状态
   * @returns 无返回值
   * @description 关闭弹窗后恢复模板模式，避免下一次打开看到上次导入的 JSON 或错误。
   */
  const reset = (): void => {
    setMode("template");
    setSelectedPreset(null);
    setTemplateMetadata({ name: "", description: "" });
    setJsonText("");
    setJsonDefinition(null);
    setJsonMetadata({ name: "", description: "" });
    setJsonError(null);
    setJsonFileName(null);
    setJsonInspection(null);
    setInspecting(false);
  };

  /**
   * 统一处理弹窗开关
   * @param next 下一步开关状态
   * @returns 无返回值
   * @description 创建或预检期间保持当前弹窗，避免异步响应落到已关闭或已重置的表单；其余关闭
   * 入口都先清空本轮状态，再通知父页面。
   */
  const handleOpenChange = (next: boolean): void => {
    if (creating || inspecting) return;
    if (!next) reset();
    onOpenChange(next);
  };

  /**
   * 解析当前 JSON 文本并初始化可覆盖的元数据
   * @param text 待解析文本，默认使用编辑区当前内容
   * @returns 返回解析是否成功
   * @description 文件选择和手动粘贴共用该入口，契约与图结构仍由创建接口校验。
   */
  const parseJson = async (text = jsonText): Promise<boolean> => {
    const result = parseFlowCreationJson(text);
    if (!result.ok) {
      setJsonDefinition(null);
      setJsonError(result.error);
      return false;
    }
    setInspecting(true);
    try {
      const inspection = await onInspect(result.definition);
      setJsonInspection(inspection);
      if (!inspection.definition) {
        setJsonDefinition(null);
        setJsonError(
          inspection.errors[0]?.message ?? "这份 Definition 无法导入",
        );
        return false;
      }
      setJsonDefinition(inspection.definition);
      setJsonMetadata(result.metadata);
      setJsonError(null);
      return true;
    } catch (error) {
      setJsonDefinition(null);
      setJsonInspection(null);
      setJsonError(
        error instanceof Error ? error.message : "Definition 预检失败",
      );
      return false;
    } finally {
      setInspecting(false);
    }
  };

  /**
   * 读取管理员选择的 JSON 文件
   * @param file 浏览器文件选择器返回的单个文件
   * @returns 文件读取与解析完成后的 Promise
   * @description 只接受 `.json` 或 `application/json`，读取失败时保留弹窗并展示原因。
   */
  const readJsonFile = async (file: File): Promise<void> => {
    setJsonFileName(null);
    if (
      !file.name.toLowerCase().endsWith(".json") &&
      file.type !== "application/json"
    ) {
      setJsonError("请选择 .json 文件");
      setJsonDefinition(null);
      return;
    }
    try {
      const text = await file.text();
      setJsonText(text);
      setJsonFileName(file.name);
      await parseJson(text);
    } catch (error) {
      setJsonDefinition(null);
      setJsonError(error instanceof Error ? error.message : "文件读取失败");
    }
  };

  /**
   * 提交当前模式构造出的完整 Definition
   * @param intent 创建后停留列表或直接进入编辑器
   * @returns 创建请求完成后的 Promise
   * @description 只覆盖顶层名称和描述；请求失败时父页面不会关闭弹窗。
   */
  const submit = async (intent: FlowCreateIntent): Promise<void> => {
    if (!sourceDefinition || !metadata.name.trim()) return;
    await onCreate(
      applyFlowCreationMetadata(sourceDefinition, metadata),
      intent,
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <div>
          <DialogTitle>新建 Flow</DialogTitle>
          <DialogDescription>
            从模板开始或导入完整
            Definition。创建的是草稿版本，发布后才能被智能体绑定运行。
          </DialogDescription>
        </div>

        <div className="grid grid-cols-2 rounded-md bg-muted p-1">
          <Button
            type="button"
            size="sm"
            variant={mode === "template" ? "secondary" : "ghost"}
            onClick={() => setMode("template")}
            disabled={creating || inspecting}
          >
            <LayoutTemplate />
            模板创建
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "json" ? "secondary" : "ghost"}
            onClick={() => setMode("json")}
            disabled={creating || inspecting}
          >
            <FileJson />
            JSON 导入
          </Button>
        </div>

        <div className="min-h-0 overflow-y-auto px-0.5">
          {mode === "template" ? (
            templates.length === 0 ? (
              // 模板列表拿不到时明确说明，而不是显示一个空白弹窗让人以为没有模板
              <p className="py-8 text-center text-sm text-muted-foreground">
                没能取到内置模板；请确认后端 /admin/agent-flow-templates 可用。
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {templates.map((template) => (
                  <TemplateCard
                    key={template.preset}
                    template={template}
                    active={template.preset === selectedPreset}
                    disabled={creating || inspecting}
                    onSelect={() => {
                      setSelectedPreset(template.preset);
                      setTemplateMetadata({
                        name: template.name,
                        description: template.description,
                      });
                    }}
                  />
                ))}
              </div>
            )
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" asChild>
                  <label
                    htmlFor="flow-json-file"
                    aria-disabled={creating}
                    className={cn(
                      "cursor-pointer",
                      (creating || inspecting) &&
                        "pointer-events-none opacity-50",
                    )}
                  >
                    <Upload />
                    选择 JSON 文件
                  </label>
                </Button>
                <input
                  id="flow-json-file"
                  className="sr-only"
                  type="file"
                  accept="application/json,.json"
                  disabled={creating || inspecting}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readJsonFile(file);
                    event.target.value = "";
                  }}
                />
                {jsonFileName ? (
                  <span className="max-w-72 truncate text-xs text-muted-foreground">
                    {jsonFileName}
                  </span>
                ) : null}
              </div>
              <Textarea
                value={jsonText}
                rows={12}
                spellCheck={false}
                disabled={creating || inspecting}
                placeholder='粘贴完整 Flow Definition，例如 { "schemaVersion": 9, ... }'
                className="min-h-56 resize-y font-mono text-xs"
                onChange={(event) => {
                  setJsonText(event.target.value);
                  setJsonDefinition(null);
                  setJsonError(null);
                  setJsonFileName(null);
                  setJsonInspection(null);
                }}
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {jsonDefinition
                    ? "JSON 已解析；最终契约和图结构将在创建时校验"
                    : "先解析 JSON，再确认名称和描述"}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void parseJson()}
                  disabled={!jsonText.trim() || creating || inspecting}
                >
                  {inspecting ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <FileJson />
                  )}
                  {inspecting ? "预检中" : "解析并预检"}
                </Button>
              </div>
              {jsonInspection?.status === "upgradeable" &&
              jsonInspection.report ? (
                <div className="rounded-md border border-[var(--lb-warning)] bg-[var(--lb-warning-soft)] p-3 text-xs">
                  <p className="font-medium text-foreground">
                    将从 Definition v{jsonInspection.report.fromVersion} 升级到
                    v{jsonInspection.report.toVersion}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    补齐 {jsonInspection.report.loopAssignments.length} 个节点的
                    Loop 归属，转换{" "}
                    {jsonInspection.report.relativeLayoutNodeIds.length}
                    个节点坐标；确认创建后只写入升级后的当前版本草稿。
                  </p>
                </div>
              ) : null}
              {jsonError ? (
                <p className="text-xs text-[var(--lb-danger)]">{jsonError}</p>
              ) : null}
            </div>
          )}

          {sourceDefinition ? (
            <MetadataFields
              metadata={metadata}
              disabled={creating}
              onChange={
                mode === "template" ? setTemplateMetadata : setJsonMetadata
              }
            />
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={creating || inspecting}
          >
            取消
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!canCreate || creating || inspecting}
            onClick={() => void submit("create")}
          >
            {creating ? <Loader2 className="animate-spin" /> : <Plus />}
            创建
          </Button>
          <Button
            size="sm"
            disabled={!canCreate || creating || inspecting}
            onClick={() => void submit("create-and-edit")}
          >
            {creating ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            创建并编辑
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Flow 创建时共享的名称与描述字段
 * @param metadata 当前模式独立维护的元数据
 * @param disabled 创建请求进行中时是否禁用输入
 * @param onChange 元数据变化回调
 * @returns 返回名称和描述表单
 */
function MetadataFields({
  metadata,
  disabled,
  onChange,
}: {
  metadata: FlowCreationMetadata;
  disabled: boolean;
  onChange: (metadata: FlowCreationMetadata) => void;
}) {
  return (
    <div className="mt-3 grid gap-3 rounded-md border border-border p-3">
      <div className="space-y-1.5">
        <Label htmlFor="new-flow-name">名称</Label>
        <Input
          id="new-flow-name"
          value={metadata.name}
          maxLength={100}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...metadata, name: event.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-flow-description">描述</Label>
        <Textarea
          id="new-flow-description"
          value={metadata.description}
          maxLength={2000}
          disabled={disabled}
          className="min-h-[72px]"
          onChange={(event) =>
            onChange({ ...metadata, description: event.target.value })
          }
        />
      </div>
    </div>
  );
}

/** 单个模板选项卡。 */
function TemplateCard({
  template,
  active,
  disabled,
  onSelect,
}: {
  template: AgentFlowTemplate;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const layers = useMemo(() => readNodeLayers(template.definition), [template]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        "flex h-full flex-col gap-1.5 rounded-md border px-3 py-2 text-left transition-colors disabled:pointer-events-none disabled:opacity-50",
        active
          ? "border-primary bg-muted"
          : "border-border hover:border-primary hover:bg-muted/60",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-foreground">
          {template.name}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {template.preset}
        </span>
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        {template.description || "无描述"}
      </p>
      {layers === null ? (
        <Badge variant="warning" className="w-fit">
          结构无法解析
        </Badge>
      ) : (
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {layers.map((layer, index) => (
            <span key={index} className="flex items-center gap-1">
              {index > 0 ? (
                <span className="text-xs text-muted-foreground">→</span>
              ) : null}
              <span className="flex items-center gap-0.5">
                {layer.map((type, typeIndex) => {
                  const Icon = NODE_TYPE_ICONS[type];
                  return (
                    <span
                      key={typeIndex}
                      className="inline-flex items-center gap-0.5 rounded bg-background px-1 py-0.5 text-xs text-muted-foreground"
                      title={nodeTypeMeta(type).name}
                    >
                      {Icon ? <Icon className="h-3 w-3" /> : null}
                      {nodeTypeMeta(type).name}
                    </span>
                  );
                })}
              </span>
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

/**
 * 把模板的节点按执行层级分组
 * @param definition 模板 Definition
 * @returns 返回每一层的节点类型；无法投影时返回 null
 * @description 层级取自画布投影算出的 x 坐标（自动排布按距入口的最长路径分层），因此顺序是
 * 从图推出来的，不是照着 nodes 数组顺序假设的——数组顺序和执行顺序没有必然关系。
 * 同一层的多个节点是并行分支，放在同一格里。
 */
function readNodeLayers(definition: object): FlowNodeType[][] | null {
  const parsed = readDefinitionForCanvas(definition);
  if (!parsed.ok) {
    return null;
  }
  const byColumn = new Map<number, FlowNodeType[]>();
  for (const node of toFlowGraph(parsed.definition).nodes) {
    byColumn.set(node.position.x, [
      ...(byColumn.get(node.position.x) ?? []),
      node.type,
    ]);
  }
  return [...byColumn.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, types]) => types);
}
