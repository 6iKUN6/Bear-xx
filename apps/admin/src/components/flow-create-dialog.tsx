import { useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
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
import type { AgentFlowTemplate } from "@/api/types";

interface FlowCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: AgentFlowTemplate[];
  creating: boolean;
  onCreate: (
    template: AgentFlowTemplate,
    metadata: { name: string; description: string },
  ) => void;
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
  onCreate,
}: FlowCreateDialogProps) {
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [metadata, setMetadata] = useState({ name: "", description: "" });

  // blank 排最前：从空白起步比从某个预设改起更常用。后端已经这样排，这里不再重排，
  // 只在缺失时兜底提示，避免前端和后端各有一套顺序
  const selected = useMemo(
    () => templates.find((item) => item.preset === selectedPreset) ?? null,
    [templates, selectedPreset],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSelectedPreset(null);
          setMetadata({ name: "", description: "" });
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <div>
          <DialogTitle>新建 Flow</DialogTitle>
          <DialogDescription>
            选一个起点。创建出的是草稿版本，发布后才能被智能体绑定运行。
          </DialogDescription>
        </div>

        {templates.length === 0 ? (
          // 模板列表拿不到时明确说明，而不是显示一个空白弹窗让人以为没有模板
          <p className="py-8 text-center text-sm text-muted-foreground">
            没能取到内置模板；请确认后端 /admin/agent-flow-templates 可用。
          </p>
        ) : (
          <div className="-mx-1 grid grid-cols-2 gap-2 overflow-y-auto px-1">
            {templates.map((template) => (
              <TemplateCard
                key={template.preset}
                template={template}
                active={template.preset === selectedPreset}
                onSelect={() => {
                  setSelectedPreset(template.preset);
                  setMetadata({
                    name: template.name,
                    description: template.description,
                  });
                }}
              />
            ))}
          </div>
        )}

        {selected ? (
          <div className="grid gap-3 rounded-md border border-border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-flow-name">名称</Label>
              <Input
                id="new-flow-name"
                value={metadata.name}
                maxLength={100}
                onChange={(event) =>
                  setMetadata((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-flow-description">描述</Label>
              <Textarea
                id="new-flow-description"
                value={metadata.description}
                maxLength={2000}
                className="min-h-[72px]"
                onChange={(event) =>
                  setMetadata((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            取消
          </Button>
          <Button
            size="sm"
            disabled={!selected || !metadata.name.trim() || creating}
            onClick={() => {
              if (selected) {
                onCreate(selected, {
                  name: metadata.name.trim(),
                  description: metadata.description.trim(),
                });
              }
            }}
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {selected ? `以「${selected.name}」创建` : "请选择一个起点"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 单个模板选项卡。 */
function TemplateCard({
  template,
  active,
  onSelect,
}: {
  template: AgentFlowTemplate;
  active: boolean;
  onSelect: () => void;
}) {
  const layers = useMemo(() => readNodeLayers(template.definition), [template]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "flex h-full flex-col gap-1.5 rounded-md border px-3 py-2 text-left transition-colors",
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
