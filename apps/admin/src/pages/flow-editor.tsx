import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import type { FlowNodeType } from "@litter-bear/types/agent-flow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FLOW_NODE_DRAG_TYPE, FlowCanvas } from "@/components/flow-canvas";
import { FlowNodeInspector } from "@/components/flow-node-inspector";
import {
  useAgentCapabilities,
  useAgentFlow,
  useAgentFlowMutations,
} from "@/hooks/queries";
import { describeApiError, versionStatusMeta } from "@/lib/flow-meta";
import { flowAdvisories } from "@/lib/flow-advisories";
import {
  NODE_TYPE_ICONS,
  layoutPositions,
  nodeTypeMeta,
  type FlowNodePosition,
} from "@/lib/flow-graph";
import {
  addNode,
  branchKeysOf,
  connect,
  disconnect,
  moveNode,
  removeNode,
  renameConditionCase,
  setNodeName,
  toEditableDefinition,
  updateNodeConfig,
  type EditResult,
  type EditableDefinition,
} from "@/lib/flow-edit";
import type { AgentFlowValidation } from "@/api/types";

/** 左栏可添加的节点类型；start 不在其中——它有且仅有一个，由模板带来。 */
const ADDABLE_NODE_TYPES: FlowNodeType[] = [
  "agent",
  "plan",
  "approval",
  "plan-loop",
  "synthesize",
  "condition",
  "join",
];

/**
 * Flow 画布编辑器
 * @returns 返回左中右三栏编辑页
 * @description 左栏加节点、中间画布连线拖动、右栏改配置，保存走草稿覆盖端点。
 * 只有 DRAFT 且契约兼容的版本可编辑；其余版本进入只读模式并说明原因，而不是给一堆
 * 点了会失败的按钮。改动只存在本地直到点保存——**没有做撤销栈**，这一点写在页头。
 */
export function FlowEditorPage() {
  const { flowId, versionId } = useParams<{
    flowId: string;
    versionId: string;
  }>();
  const { data: flow, isLoading } = useAgentFlow(flowId);
  const { data: capabilities } = useAgentCapabilities();
  const { validate, saveDraft } = useAgentFlowMutations(flowId);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [validation, setValidation] = useState<AgentFlowValidation | null>(
    null,
  );
  const [draft, setDraft] = useState<EditableDefinition | null>(null);
  const [openPanels, setOpenPanels] = useState({ palette: true, nodes: true });
  const togglePanel = (key: "palette" | "nodes") =>
    setOpenPanels((current) => ({ ...current, [key]: !current[key] }));

  const version = useMemo(
    () => flow?.versions.find((item) => item.id === versionId) ?? null,
    [flow, versionId],
  );

  // updatedAt 进 key：保存成功后服务端返回的规范化 Definition 要回灌草稿
  const versionKey = version ? `${version.id}:${version.updatedAt}` : null;
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  // 渲染期同步派生状态而非用 effect：避免先渲染一帧旧图再被覆盖
  if (version && versionKey !== syncedKey) {
    setSyncedKey(versionKey);
    const parsed = toEditableDefinition(version.definition);
    setDraft(parsed.ok ? parsed.definition : null);
    setReadError(parsed.ok ? null : parsed.reason);
    setValidation(null);
  }

  const canEdit = Boolean(
    version?.status === "DRAFT" && version.schemaCompatible && draft,
  );
  const dirty = useMemo(
    () =>
      Boolean(
        version &&
        draft &&
        JSON.stringify(draft) !== JSON.stringify(version.definition),
      ),
    [draft, version],
  );

  const selectedNode = useMemo(
    () => draft?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [draft, selectedNodeId],
  );

  /** 把校验错误按节点归组：path 形如 `nodes.2.config...`，下标对应 Definition 里的节点顺序 */
  const errorsByNode = useMemo(() => {
    const grouped = new Map<
      string,
      Array<{ path: string; rule: string; message: string }>
    >();
    if (!validation || validation.valid || !draft) {
      return grouped;
    }
    for (const error of validation.errors) {
      const matched = /^nodes\.(\d+)\b/.exec(error.path);
      const node = matched ? draft.nodes[Number(matched[1])] : undefined;
      if (!node) {
        continue;
      }
      grouped.set(node.id, [...(grouped.get(node.id) ?? []), error]);
    }
    return grouped;
  }, [validation, draft]);

  /**
   * 编辑期提示：合法但大概率不是本意的图
   * @description 与校验错误分开。校验要点保存、且描述的是「服务端会拒」；提示随草稿实时算，
   * 描述的是「能存能跑，但结果可能不是你要的」。两者混在一起会让人以为提示也阻塞保存。
   */
  const advisories = useMemo(
    () => (draft ? flowAdvisories(draft) : []),
    [draft],
  );

  /** 没能归到具体节点的错误（边、图级规则）单独展示，不能悄悄丢掉 */
  const graphErrors = useMemo(() => {
    if (!validation || validation.valid) {
      return [];
    }
    const nodeScoped = new Set(
      [...errorsByNode.values()].flat().map((error) => error.path),
    );
    return validation.errors.filter((error) => !nodeScoped.has(error.path));
  }, [validation, errorsByNode]);

  /** 统一处理带护栏的编辑操作：被挡住时把原因原样告诉用户 */
  const applyEdit = (result: EditResult) => {
    if (!result.ok) {
      toast.error(result.reason);
      return;
    }
    setDraft(result.definition);
    // 图一变，上一次的校验结论就不再描述当前草稿，留着等于给出过期的绿灯
    setValidation(null);
  };

  /**
   * 在指定落点加一个节点
   * @param type 节点类型
   * @param position 画布坐标系下的落点
   * @description 只由「从左侧拖到画布」触发，因此落点一定是用户指定的、可见的。
   * 此前还有个「点击添加」的入口，把节点放在现有节点最右侧——而 fitView 只在初始化时
   * 适配一次，新节点落在可视区外，看起来像"没加上"。删掉那个入口比去猜该把视口移到哪更好。
   *
   * 坐标一并写实现有节点的位置（layoutPositions 而非 layout.nodes）：模板不带 layout，
   * 读那个稀疏映射会让一部分节点用存的坐标、一部分走自动排布，两套坐标系混用必然重叠。
   */
  const handleAddNode = (type: FlowNodeType, position: FlowNodePosition) => {
    if (!draft) return;
    applyEdit(addNode(draft, type, position, layoutPositions(draft)));
  };

  /**
   * 二次确认后删除节点
   * @param nodeId 目标节点
   * @description 确认文案里带上会连带删掉的连线数：删节点会一并清掉它的所有边（否则会留下
   * 端点不存在的悬空边），这是用户最容易没预期到的后果，比「确定删除吗」有信息量。
   * 编辑器没有撤销栈，删错只能刷新页面放弃全部改动，所以这一步必须拦。
   */
  const handleDeleteNode = (nodeId: string) => {
    if (!draft) return;
    const affectedEdges = draft.edges.filter(
      (edge) => edge.from === nodeId || edge.to === nodeId,
    ).length;
    const suffix =
      affectedEdges > 0 ? `，并一并删除与它相连的 ${affectedEdges} 条连线` : "";
    if (!window.confirm(`删除节点「${nodeId}」${suffix}？此操作无法撤销。`)) {
      return;
    }
    applyEdit(removeNode(draft, nodeId));
    if (selectedNodeId === nodeId) {
      setSelectedNodeId(null);
    }
  };

  const handleConnect = (from: string, to: string) => {
    if (!draft) return;
    const source = draft.nodes.find((node) => node.id === from);
    if (!source) return;
    const declared = branchKeysOf(source);
    const covered = new Set(
      draft.edges
        .filter((edge) => edge.from === from)
        .map((edge) => edge.when ?? "default"),
    );
    // default 可重复连出（并行扇出），具名分支各自只能连一条。因此只在具名分支里找空位，
    // 找不到再回落到 default——普通节点只有 default，扇出时它永远是"已占用"的。
    const branch =
      declared.find((key) => key !== "default" && !covered.has(key)) ??
      (declared.includes("default") ? "default" : undefined);
    if (!branch) {
      toast.error(`节点「${from}」的所有分支都已连出`);
      return;
    }
    const result = connect(draft, from, to, branch);
    applyEdit(result);
    if (result.ok && branch !== "default") {
      // 一个源节点可能有多个未连分支，这里取第一个未占用的；告诉用户建的是哪条，
      // 免得他以为连的是另一条然后去 JSON 里找
      toast.success(`已连出分支「${branch}」`);
    }
  };

  const handleSave = async () => {
    if (!version || !draft) return;
    try {
      await saveDraft.mutateAsync({
        versionId: version.id,
        definition: draft,
      });
      setValidation(null);
      toast.success("草稿已保存");
    } catch (err) {
      toast.error(describeApiError(err, "保存失败"));
    }
  };

  const handleValidate = async () => {
    if (!version) return;
    if (dirty) {
      toast.error("先保存：校验针对的是已保存的版本");
      return;
    }
    try {
      const result = await validate.mutateAsync(version.id);
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

  if (isLoading) {
    return <Skeleton className="h-[600px] w-full" />;
  }
  if (!flow || !version) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          该 Flow 版本不存在或已被删除。
          <Button variant="link" asChild>
            <Link to={flowId ? `/flows/${flowId}` : "/flows"}>返回</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const statusMeta = versionStatusMeta(version.status);
  const readOnlyReason = !version.schemaCompatible
    ? "该版本不符合当前 Definition 契约"
    : version.status !== "DRAFT"
      ? "只有草稿版本可编辑"
      : readError;

  return (
    <div className="flex h-screen flex-col gap-3 bg-background p-3">
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/flows/${flowId}`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-foreground">
              {flow.name}
            </h1>
            <Badge variant="outline">v{version.version}</Badge>
            <Badge variant={statusMeta.variant} title={statusMeta.desc}>
              {statusMeta.name}
            </Badge>
            {version.schemaCompatible ? null : (
              <Badge variant="warning">契约不兼容</Badge>
            )}
            {dirty ? <Badge variant="warning">未保存</Badge> : null}
            {canEdit ? null : <Badge variant="outline">只读</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {canEdit
              ? "改动只在本地，点保存才落库；没有撤销栈，误删请刷新页面放弃改动"
              : (readOnlyReason ?? "只读")}
          </p>
        </div>
        {canEdit ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || saveDraft.isPending}
          >
            {saveDraft.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            保存
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={handleValidate}
          disabled={validate.isPending || !version.schemaCompatible || dirty}
          title={
            dirty
              ? "先保存：校验针对已保存的版本"
              : version.schemaCompatible
                ? "向服务端校验此版本"
                : "工件不符合当前契约，服务端一定拒绝"
          }
        >
          {validate.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          校验
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[212px_1fr_336px] gap-3">
        <Card className="min-h-0 overflow-y-auto">
          <CardContent className="space-y-3 p-3">
            {canEdit ? (
              <section>
                <PanelHeader
                  title="添加节点"
                  open={openPanels.palette}
                  onToggle={() => togglePanel("palette")}
                />
                <div className="space-y-1" hidden={!openPanels.palette}>
                  {ADDABLE_NODE_TYPES.map((type) => {
                    const meta = nodeTypeMeta(type);
                    const Icon = NODE_TYPE_ICONS[type];
                    return (
                      <div
                        key={type}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData(FLOW_NODE_DRAG_TYPE, type);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        className="cursor-grab rounded-md border border-border px-2 py-1.5 transition-colors hover:border-primary hover:bg-muted active:cursor-grabbing"
                      >
                        <div className="flex items-center gap-1.5">
                          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-sm text-foreground">
                            {meta.name}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {meta.type}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                          {meta.desc}
                        </p>
                      </div>
                    );
                  })}
                </div>
                {openPanels.palette ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    拖到画布上想放的位置。
                  </p>
                ) : null}
              </section>
            ) : null}

            <section>
              <PanelHeader
                title={`节点（${draft?.nodes.length ?? 0}）`}
                open={openPanels.nodes}
                onToggle={() => togglePanel("nodes")}
              />
              <div className="space-y-0.5" hidden={!openPanels.nodes}>
                {draft?.nodes.map((node) => {
                  const nodeErrors = errorsByNode.get(node.id) ?? [];
                  return (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => setSelectedNodeId(node.id)}
                      className={`flex w-full flex-col rounded px-2 py-1 text-left transition-colors hover:bg-muted ${
                        node.id === selectedNodeId ? "bg-muted" : ""
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-sm text-foreground">
                        {(() => {
                          const Icon = NODE_TYPE_ICONS[node.type];
                          return Icon ? (
                            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : null;
                        })()}
                        {node.name || node.id}
                        {nodeErrors.length > 0 ? (
                          <span className="text-[var(--lb-danger)]">•</span>
                        ) : null}
                      </span>
                      {/* 别名、机器标识、节点类型三层都要露出来，否则会被混为一谈 */}
                      <span className="pl-5 text-xs text-muted-foreground">
                        {node.name ? (
                          <span className="mr-1 font-mono opacity-70">
                            {node.id}
                          </span>
                        ) : null}
                        {nodeTypeMeta(node.type).name}
                        <span className="ml-1 font-mono opacity-70">
                          {nodeTypeMeta(node.type).type}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </CardContent>
        </Card>

        <Card className="min-h-0">
          <CardContent className="flex h-full flex-col p-3">
            {draft ? (
              <div className="min-h-0 flex-1">
                <FlowCanvas
                  definition={draft}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={setSelectedNodeId}
                  editable={canEdit}
                  onMoveNode={(nodeId, position) =>
                    setDraft((current) =>
                      current ? moveNode(current, nodeId, position) : current,
                    )
                  }
                  onConnect={handleConnect}
                  onDeleteEdge={(from, to, branch) => {
                    if (draft) {
                      applyEdit(disconnect(draft, from, to, branch));
                    }
                  }}
                  onDeleteNode={handleDeleteNode}
                  onDropNodeType={handleAddNode}
                />
              </div>
            ) : (
              <p className="py-16 text-center text-xs text-muted-foreground">
                {readError ?? "该版本无法渲染"}
              </p>
            )}
            {canEdit ? (
              <p className="mt-2 shrink-0 text-xs text-muted-foreground">
                从节点右侧圆点拖到另一节点即连线；右键节点或连线可删除。
                普通节点连出多条边即并行扇出，汇聚请用 join 节点并在右侧选择要等的分支。
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="min-h-0 overflow-y-auto">
          <CardContent className="p-3">
            {graphErrors.length > 0 ? (
              <section className="mb-3 rounded-md border border-[var(--lb-danger)] bg-[var(--lb-danger-soft)] px-2 py-1.5">
                <h3 className="text-xs font-medium text-foreground">
                  图级校验问题
                </h3>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {graphErrors.map((error) => (
                    <li key={`${error.path}:${error.rule}`}>
                      <span className="font-mono">{error.rule}</span>{" "}
                      {error.message}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {advisories.length > 0 ? (
              <section className="mb-3 rounded-md border border-[var(--lb-warning)] bg-[var(--lb-warning-soft)] px-2 py-1.5">
                <h3 className="text-xs font-medium text-foreground">
                  编辑建议（不阻塞保存）
                </h3>
                <ul className="mt-1 space-y-1.5 text-xs">
                  {advisories.map((advisory) => (
                    <li key={advisory.id}>
                      {advisory.nodeId ? (
                        <button
                          type="button"
                          onClick={() => setSelectedNodeId(advisory.nodeId!)}
                          className="text-left font-medium text-foreground underline decoration-dotted hover:decoration-solid"
                        >
                          {advisory.title}
                        </button>
                      ) : (
                        <span className="font-medium text-foreground">
                          {advisory.title}
                        </span>
                      )}
                      <p className="mt-0.5 text-muted-foreground">
                        {advisory.detail}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {selectedNode && draft ? (
              <FlowNodeInspector
                node={selectedNode}
                definition={draft}
                errors={errorsByNode.get(selectedNode.id) ?? []}
                {...(canEdit
                  ? {
                      editing: {
                        capabilities: {
                          toolGroups: (capabilities?.toolGroups ?? []).map(
                            (group) => group.name,
                          ),
                          modelPresets: capabilities?.modelPresets ?? [],
                        },
                        onChangeConfig: (config) =>
                          setDraft((current) =>
                            current
                              ? updateNodeConfig(
                                  current,
                                  selectedNode.id,
                                  config,
                                )
                              : current,
                          ),
                        onChangeName: (name) =>
                          setDraft((current) =>
                            current
                              ? setNodeName(current, selectedNode.id, name)
                              : current,
                          ),
                        onRenameCase: (oldKey, newKey) =>
                          applyEdit(
                            renameConditionCase(
                              draft,
                              selectedNode.id,
                              oldKey,
                              newKey,
                            ),
                          ),
                        onDeleteNode: () => handleDeleteNode(selectedNode.id),
                      },
                    }
                  : {})}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                {draft
                  ? "在左栏或画布上选择一个节点"
                  : (readError ?? "该版本无法渲染")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * 左栏分组的可折叠小标题
 * @param props 标题、展开态与切换回调
 * @returns 返回可点击的小标题行
 * @description 用 hidden 属性隐藏内容而不是不渲染：折叠起来时里面的滚动位置与选中态还在，
 * 展开后不会跳回顶部。
 */
function PanelHeader({
  title,
  open,
  onToggle,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="mb-1 flex w-full items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
    >
      {open ? (
        <ChevronDown className="h-3 w-3" />
      ) : (
        <ChevronRight className="h-3 w-3" />
      )}
      {title}
    </button>
  );
}
