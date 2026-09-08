import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Redo2,
  Save,
  Undo2,
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
  resolveNodeProvider,
  type NodeProviderInfo,
} from "@/lib/flow-node-model";
import {
  EMPTY_HISTORY,
  pushHistory,
  redoHistory,
  undoHistory,
  type EditorHistory,
} from "@/lib/editor-history";
import {
  NODE_TYPE_ICONS,
  layoutPositions,
  nodeTypeMeta,
  type FlowNodePosition,
} from "@/lib/flow-graph";
import { nodeTypeColors } from "@/lib/flow-node-colors";
import {
  addNode,
  branchKeysOf,
  connect,
  disconnect,
  disconnectNodeAll,
  duplicateNode,
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
import { confirm } from "@/components/confirm-dialog";
import {
  FLOW_EDITOR_PANEL_LIMITS,
  useUiStore,
} from "@/stores/ui-store";

/**
 * 左栏可添加的节点类型
 * @description start 与 end 不在其中——它们都唯一，由模板带来且不能删除。
 */
const ADDABLE_NODE_TYPES: FlowNodeType[] = [
  "agent",
  "plan",
  "approval",
  "plan-loop",
  "synthesize",
  "condition",
  "join",
  "loop",
];

/**
 * Flow 画布编辑器
 * @returns 返回左中右三栏编辑页
 * @description 左栏加节点、中间画布连线拖动、右栏改配置，保存走草稿覆盖端点。
 * 只有 DRAFT 且契约兼容的版本可编辑；其余版本进入只读模式并说明原因，而不是给一堆
 * 点了会失败的按钮。改动只存在本地直到点保存，期间可用 Ctrl+Z / Ctrl+Shift+Z 撤销重做。
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
  const [history, setHistory] = useState<EditorHistory>(EMPTY_HISTORY);
  /** 连续输入合并：同名 key 在时间窗内再次提交时不新增历史条目（inspector 逐字符改名不灌满栈） */
  const lastCoalesceRef = useRef<{ key: string; at: number } | null>(null);
  const [openPanels, setOpenPanels] = useState({ palette: true, nodes: true });
  const togglePanel = (key: "palette" | "nodes") =>
    setOpenPanels((current) => ({ ...current, [key]: !current[key] }));

  // 左右栏宽度持久化在 ui-store；增量式 resize 读 getState() 拿最新值，不依赖渲染闭包
  const panels = useUiStore((state) => state.flowEditorPanels);
  const setFlowEditorPanels = useUiStore((state) => state.setFlowEditorPanels);
  const resizeLeft = (deltaX: number) => {
    const current = useUiStore.getState().flowEditorPanels;
    const { min, max } = FLOW_EDITOR_PANEL_LIMITS.left;
    setFlowEditorPanels({
      ...current,
      left: Math.min(max, Math.max(min, current.left + deltaX)),
    });
  };
  const resizeRight = (deltaX: number) => {
    const current = useUiStore.getState().flowEditorPanels;
    const { min, max } = FLOW_EDITOR_PANEL_LIMITS.right;
    // 右栏向左拖变宽、向右拖变窄：增量取反
    setFlowEditorPanels({
      ...current,
      right: Math.min(max, Math.max(min, current.right - deltaX)),
    });
  };

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
    // 服务端回灌（含保存成功后的规范化结果）使本地历史语义失效，必须清零：
    // 否则 undo 会拿保存前的本地草稿覆盖掉服务端的规范化版本
    setHistory(EMPTY_HISTORY);
    lastCoalesceRef.current = null;
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

  /** 节点 id → 接入供应商：capabilities 异步到达后也要刷新，随 draft/capabilities 重算 */
  const nodeProviders = useMemo(() => {
    const map = new Map<string, NodeProviderInfo>();
    if (!draft || !capabilities) {
      return map;
    }
    for (const node of draft.nodes) {
      const info = resolveNodeProvider(
        node.type,
        node.config,
        capabilities.modelPresets,
      );
      if (info) {
        map.set(node.id, info);
      }
    }
    return map;
  }, [draft, capabilities]);

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

  /** 校验未通过的节点 id 集：画布据此给节点描 danger 边框，与左栏红点互为双重信号 */
  const errorNodeIds = useMemo(
    () => new Set(errorsByNode.keys()),
    [errorsByNode],
  );

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

  /** 连续输入合并的时间窗（毫秒）：同名 key 在窗口内再次提交不新增历史条目 */
  const COALESCE_WINDOW_MS = 800;

  /**
   * 所有草稿改动的唯一提交入口
   * @param next 改动后的新草稿
   * @param coalesceKey 连续编辑合并键（如 `name:节点id`）；窗口内同键提交直接推进草稿、不压栈
   * @description applyEdit 与 inspector 的裸 setDraft（改名/改配置/拖动落点）都走这里，
   * 保证每个可撤销的动作都恰好留下一份编辑前快照。
   */
  const commitDraft = (next: EditableDefinition, coalesceKey?: string) => {
    if (!draft) return;
    const now = Date.now();
    const coalescing =
      coalesceKey !== undefined &&
      lastCoalesceRef.current?.key === coalesceKey &&
      now - lastCoalesceRef.current.at < COALESCE_WINDOW_MS;
    if (!coalescing) {
      setHistory((current) => pushHistory(current, draft));
    }
    lastCoalesceRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;
    setDraft(next);
    // 图一变，上一次的校验结论就不再描述当前草稿，留着等于给出过期的绿灯
    setValidation(null);
  };

  /** 统一处理带护栏的编辑操作：被挡住时把原因原样告诉用户 */
  const applyEdit = (result: EditResult) => {
    if (!result.ok) {
      toast.error(result.reason);
      return;
    }
    commitDraft(result.definition);
  };

  /** 撤销/重做后恢复出的草稿里可能已没有当前选中节点，顺手清掉避免 inspector 悬空 */
  const restoreDraft = (result: {
    history: EditorHistory;
    draft: EditableDefinition;
  }) => {
    lastCoalesceRef.current = null;
    setHistory(result.history);
    setDraft(result.draft);
    setValidation(null);
    if (
      selectedNodeId &&
      result.draft.nodes.every((node) => node.id !== selectedNodeId)
    ) {
      setSelectedNodeId(null);
    }
  };

  const handleUndo = () => {
    if (!draft) return;
    const result = undoHistory(history, draft);
    if (result) restoreDraft(result);
  };

  const handleRedo = () => {
    if (!draft) return;
    const result = redoHistory(history, draft);
    if (result) restoreDraft(result);
  };

  // Ctrl+Z / Ctrl+Shift+Z：必须跳过表单控件焦点，否则 inspector 里打字时的文本撤销
  // 会被劫持成整张图的撤销。历史栈只认 commitDraft 留下的快照，撤销不会丢改动。
  useEffect(() => {
    if (!canEdit) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== "z") return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      event.preventDefault();
      if (event.shiftKey) {
        handleRedo();
      } else {
        handleUndo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

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
   * 撤销栈已经能兜住误删，但连带影响仍值得在动手前讲清楚。
   */
  const handleDeleteNode = async (nodeId: string) => {
    if (!draft) return;
    const affectedEdges = draft.edges.filter(
      (edge) => edge.from === nodeId || edge.to === nodeId,
    ).length;
    const suffix =
      affectedEdges > 0 ? `，并一并删除与它相连的 ${affectedEdges} 条连线` : "";
    if (
      !(await confirm({
        title: "删除节点",
        description: `删除节点「${nodeId}」${suffix}？`,
        danger: true,
      }))
    ) {
      return;
    }
    applyEdit(removeNode(draft, nodeId));
    if (selectedNodeId === nodeId) {
      setSelectedNodeId(null);
    }
  };

  const handleConnect = (from: string, to: string, requestedBranch?: string) => {
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
    const branch = requestedBranch
      ? requestedBranch
      : declared.find((key) => key !== "default" && !covered.has(key)) ??
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
              ? "改动只在本地，点保存才落库；Ctrl+Z 撤销、Ctrl+Shift+Z 重做"
              : (readOnlyReason ?? "只读")}
          </p>
        </div>
        {canEdit ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleUndo}
              disabled={history.past.length === 0}
              title="撤销 (Ctrl+Z)"
            >
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRedo}
              disabled={history.future.length === 0}
              title="重做 (Ctrl+Shift+Z)"
            >
              <Redo2 className="h-4 w-4" />
            </Button>
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
          </>
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

      <div className="flex min-h-0 flex-1">
        <Card
          className="min-h-0 shrink-0 overflow-y-auto"
          style={{ width: panels.left }}
        >
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
                    const colors = nodeTypeColors(type);
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
                          {/* 与画布节点卡片同一配色（nodeTypeColors），类型一眼可辨 */}
                          <span
                            className="grid h-5 w-5 shrink-0 place-items-center rounded-sm"
                            style={{
                              background: colors.soft,
                              color: colors.color,
                            }}
                          >
                            <Icon className="h-3 w-3" />
                          </span>
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
                          const colors = nodeTypeColors(node.type);
                          return Icon ? (
                            <span
                              className="grid h-5 w-5 shrink-0 place-items-center rounded-sm"
                              style={{
                                background: colors.soft,
                                color: colors.color,
                              }}
                            >
                              <Icon className="h-3 w-3" />
                            </span>
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

        <PanelResizer onDrag={resizeLeft} label="调整左栏宽度" />

        <Card className="min-h-0 min-w-[320px] flex-1">
          <CardContent className="flex h-full flex-col p-3">
            {draft ? (
              <div className="min-h-0 flex-1">
                <FlowCanvas
                  definition={draft}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={setSelectedNodeId}
                  editable={canEdit}
                  onMoveNode={(nodeId, position) => {
                    // 拖动落点是离散提交（onNodeDragStop 才触发），拖中不进历史
                    if (draft) {
                      commitDraft(moveNode(draft, nodeId, position));
                    }
                  }}
                  onConnect={handleConnect}
                  onDeleteEdge={(from, to, branch) => {
                    if (draft) {
                      applyEdit(disconnect(draft, from, to, branch));
                    }
                  }}
                  onDeleteNode={handleDeleteNode}
                  onDuplicateNode={(nodeId) => {
                    if (draft) {
                      applyEdit(
                        duplicateNode(draft, nodeId, layoutPositions(draft)),
                      );
                    }
                  }}
                  onDisconnectAll={(nodeId) => {
                    if (draft) {
                      applyEdit(disconnectNodeAll(draft, nodeId));
                    }
                  }}
                  onDropNodeType={handleAddNode}
                  nodeProviders={nodeProviders}
                  errorNodeIds={errorNodeIds}
                  fitViewKey={version.id}
                />
              </div>
            ) : (
              <p className="py-16 text-center text-xs text-muted-foreground">
                {readError ?? "该版本无法渲染"}
              </p>
            )}
            {canEdit ? (
              <p className="mt-2 shrink-0 text-xs text-muted-foreground">
                从节点出口拖到另一节点即连线；loop 的 again/done 必须从对应出口拖出，
                循环体回到顶部返回口。右键节点或连线可删除。
                普通节点连出多条边即并行扇出，汇聚请用 join
                节点并在右侧选择要等的分支。
              </p>
            ) : null}
          </CardContent>
        </Card>

        <PanelResizer onDrag={resizeRight} label="调整右栏宽度" />

        <Card
          className="min-h-0 shrink-0 overflow-y-auto"
          style={{ width: panels.right }}
        >
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
                        onChangeConfig: (config) => {
                          if (draft) {
                            commitDraft(
                              updateNodeConfig(draft, selectedNode.id, config),
                              `config:${selectedNode.id}`,
                            );
                          }
                        },
                        onChangeName: (name) => {
                          if (draft) {
                            commitDraft(
                              setNodeName(draft, selectedNode.id, name),
                              `name:${selectedNode.id}`,
                            );
                          }
                        },
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

/**
 * 分栏拖拽手柄
 * @param props onDrag 报告自上一帧以来的横向增量（像素）
 * @returns 返回一条可拖的竖直分隔条
 * @description 用 pointer capture 在手柄自身上接收移动，增量式回调（父级读最新 store 宽度，
 * 不依赖闭包快照），所以拖出再回拖也不跳。拖动期间禁用文本选择，避免拖过头选中整页文字。
 */
function PanelResizer({
  onDrag,
  label,
}: {
  onDrag: (deltaX: number) => void;
  label: string;
}) {
  const lastX = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className="group flex w-3 shrink-0 cursor-col-resize touch-none justify-center"
      onPointerDown={(event) => {
        event.preventDefault();
        lastX.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
          return;
        }
        const deltaX = event.clientX - lastX.current;
        lastX.current = event.clientX;
        if (deltaX !== 0) {
          onDrag(deltaX);
        }
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        document.body.style.userSelect = "";
      }}
      onLostPointerCapture={() => {
        document.body.style.userSelect = "";
      }}
    >
      <div className="w-px bg-border transition-colors group-hover:bg-primary/60 group-active:bg-primary" />
    </div>
  );
}
