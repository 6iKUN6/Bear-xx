import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  Controls,
  Handle,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  ArrowRightToLine,
  ChevronDown,
  ChevronRight,
  Copy,
  Trash2,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { AnimateIcon } from "@/components/animate-ui/icons/icon";
import { Play } from "@/components/animate-ui/icons/play";
import { Bot } from "@/components/animate-ui/icons/bot";
import { ClipboardList } from "@/components/animate-ui/icons/clipboard-list";
import { User } from "@/components/animate-ui/icons/user";
import { RefreshCw } from "@/components/animate-ui/icons/refresh-cw";
import { RotateCw } from "@/components/animate-ui/icons/rotate-cw";
import { CircleCheck } from "@/components/animate-ui/icons/circle-check";
import { FileText } from "@/components/animate-ui/icons/file-text";
import { GitBranch } from "@/components/animate-ui/icons/git-branch";
import { Merge } from "@/components/animate-ui/icons/merge";
import type { FlowNodeType } from "@litter-bear/types/agent-flow";
import { cn } from "@/lib/utils";
import { ModelProviderLogo } from "@/components/model-provider-logo";
import type { NodeProviderInfo } from "@/lib/flow-node-model";
import { nodeTypeColors } from "@/lib/flow-node-colors";
import {
  NODE_TYPE_ICONS,
  nodeTypeMeta,
  readDefinitionForCanvas,
  toFlowGraph,
  type FlowGraph,
  type FlowNodePosition,
} from "@/lib/flow-graph";

/** 画布节点携带的展示数据。 */
interface FlowNodeData extends Record<string, unknown> {
  nodeId: string;
  /** 显示名；缺省时回退显示 nodeId */
  nodeName?: string;
  /** 面向编辑者的简短说明 */
  nodeDescription?: string;
  nodeType: FlowNodeType;
  selected: boolean;
  /** 连线模式：该节点是连线的源 */
  connectSource?: boolean;
  /** 连线模式：该节点是合法目标（非源、非 start——start 没有入口把手） */
  connectTarget?: boolean;
  /** 节点当前接入的模型供应商（仅配了模型预设的节点有） */
  provider?: NodeProviderInfo;
  /** 校验未通过：danger 边框，与左栏节点列表的红点互为双重信号 */
  hasError?: boolean;
  loopSummary?: string;
  loopWarning?: string;
  nodeSummary?: string;
  collapsed?: boolean;
  editable?: boolean;
  onToggleLoop?: (loopId: string) => void;
  onResizeLoop?: (
    loopId: string,
    size: { width: number; height: number },
  ) => void;
}

/**
 * 单个 Flow 节点的画布外观
 * @param props React Flow 注入的节点属性
 * @returns 返回节点卡片
 * @description 颜色只用语义 token，不写具体色值。分支节点用左右把手，与普通节点一致：
 * 分支由边上的标签表达，不靠多个把手——把手数量会随 case 增删变化，位置也会跳。
 */
/** 有 animate-ui 动态图标版本的节点类型；其余类型回退到 NODE_TYPE_ICONS 的静态 lucide 图标。 */
const NODE_TYPE_ANIMATED_ICONS: Partial<
  Record<
    FlowNodeType,
    React.ComponentType<{ size?: number; className?: string }>
  >
> = {
  start: Play,
  end: CircleCheck,
  agent: Bot,
  plan: ClipboardList,
  approval: User,
  loop: RefreshCw,
  "plan-loop": RotateCw,
  synthesize: FileText,
  condition: GitBranch,
  join: Merge,
};

function FlowCanvasNode({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  const meta = nodeTypeMeta(data.nodeType);
  const Icon = NODE_TYPE_ICONS[data.nodeType];
  const AnimatedIcon = NODE_TYPE_ANIMATED_ICONS[data.nodeType];
  const colors = nodeTypeColors(data.nodeType);
  if (data.nodeType === "loop") {
    return (
      <div
        className={cn(
          "relative h-full w-full rounded-md border-2 bg-background/85 transition-colors",
          data.hasError
            ? "border-[var(--lb-danger)]"
            : data.selected
              ? "border-primary shadow-[0_0_0_3px_var(--lb-accent-soft)]"
              : "border-border",
        )}
      >
        <NodeResizer
          minWidth={520}
          minHeight={260}
          isVisible={Boolean(data.editable && selected && !data.collapsed)}
          onResizeEnd={(_, params) =>
            data.onResizeLoop?.(data.nodeId, {
              width: params.width,
              height: params.height,
            })
          }
        />
        <Handle
          id="loop-entry"
          type="target"
          position={Position.Left}
          className="flow-handle"
        />
        <Handle
          id="done"
          type="source"
          position={Position.Right}
          className="flow-handle !bg-[var(--lb-success)]"
        />
        <div className="flex h-12 items-center gap-2 border-b border-border px-3">
          <span
            className="grid h-6 w-6 shrink-0 place-items-center rounded-sm"
            style={{ background: colors.soft, color: colors.color }}
          >
            {AnimatedIcon ? <AnimatedIcon size={14} /> : null}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {data.nodeName || data.nodeId}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {data.loopSummary}
            </p>
          </div>
          {data.loopWarning ? (
            <AlertTriangle
              className="h-4 w-4 shrink-0 text-[var(--lb-warning)]"
              aria-label={data.loopWarning}
            />
          ) : null}
          <button
            type="button"
            className="nodrag nopan grid h-7 w-7 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              data.onToggleLoop?.(data.nodeId);
            }}
            title={data.collapsed ? "展开 Loop" : "折叠 Loop"}
          >
            {data.collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>
        {data.collapsed ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {data.loopWarning ?? "循环体已折叠"}
          </div>
        ) : data.loopWarning ? (
          <div className="absolute bottom-2 left-3 flex items-center gap-1 text-xs text-[var(--lb-warning)]">
            <AlertTriangle className="h-3.5 w-3.5" />
            {data.loopWarning}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "relative min-w-[168px] rounded-md border bg-background px-3 py-2 transition-all duration-200",
        data.hasError
          ? "border-[var(--lb-danger)] ring-2 ring-[var(--lb-danger-soft)]"
          : data.selected
            ? "border-primary shadow-[0_0_0_3px_var(--lb-accent-soft),0_0_16px_var(--lb-accent-soft)]"
            : "border-border shadow-sm",
        data.connectSource && "border-primary ring-2 ring-primary/40",
        data.connectTarget &&
          "cursor-crosshair ring-2 ring-[var(--lb-accent-soft)]",
      )}
      title={data.nodeDescription || meta.desc}
    >
      {data.nodeType === "start" ? null : (
        <Handle
          type="target"
          position={Position.Left}
          className={cn("flow-handle", data.selected && "!bg-primary")}
        />
      )}
      <div className="flex items-center gap-1.5">
        {/* 图标 chip：类别色常驻（soft 底 + 类别色图标），让节点类型一眼可辨。
            选中态仍由卡片边框的 accent ring 表达，不改变 chip 的类别色。 */}
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded-sm"
          style={{ background: colors.soft, color: colors.color }}
        >
          {AnimatedIcon ? (
            <AnimateIcon animate={data.selected ? "path-loop" : false} loop>
              <AnimatedIcon size={14} className="transition-colors" />
            </AnimateIcon>
          ) : Icon ? (
            <Icon className="h-3.5 w-3.5 transition-colors" />
          ) : null}
        </span>
        <span className="text-sm font-medium text-foreground">
          {data.nodeName || data.nodeId}
        </span>
      </div>
      {/* 三层信息各有用处：起了别名时第一行是别名、这里补上机器标识 id（边和 $ref 引用的是它）；
          再跟节点类型。少任何一层都会让人把「标识」「别名」「类型」混为一谈 */}
      <div className="mt-0.5 text-xs text-muted-foreground">
        {data.nodeName ? (
          <span className="mr-1 font-mono opacity-70">{data.nodeId}</span>
        ) : null}
        {meta.name}
        <span className="ml-1 font-mono opacity-70">{meta.type}</span>
      </div>
      {data.nodeSummary ? (
        <div className="mt-1 truncate text-[11px] text-muted-foreground">
          {data.nodeSummary}
        </div>
      ) : null}
      {/* 接入了模型预设的节点在右上角亮出厂商 logo；预设已被删除（stale）时换成警示，不能在画布上装死 */}
      {data.provider ? (
        data.provider.stale ? (
          <span
            className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-background shadow-sm"
            title={`模型预设「${data.provider.name}」已不存在，请在右侧重新选择`}
          >
            <AlertTriangle className="h-3 w-3 text-[var(--lb-warning)]" />
          </span>
        ) : (
          <ModelProviderLogo
            providerKey={data.provider.providerKey}
            name={data.provider.name}
            size="sm"
            className="absolute -right-1.5 -top-1.5 rounded-full shadow-sm"
          />
        )
      ) : null}
      {data.nodeType === "end" ? null : (
        <Handle
          id="default"
          type="source"
          position={Position.Right}
          className={cn("flow-handle", data.selected && "!bg-primary")}
        />
      )}
    </div>
  );
}

const NODE_TYPES = { flowNode: FlowCanvasNode } as const;

/** 拖入画布时携带节点类型的 dataTransfer 键。 */
export const FLOW_NODE_DRAG_TYPE = "application/lb-flow-node";

/** 右键菜单的目标；节点与边各有自己的动作集。 */
type ContextTarget =
  | {
      kind: "node";
      nodeId: string;
      nodeType: FlowNodeType;
      /** 该节点当前连边数，用于置灰「断开所有连线」 */
      edgeCount: number;
      x: number;
      y: number;
    }
  | {
      kind: "edge";
      from: string;
      to: string;
      branch: string;
      x: number;
      y: number;
    };

interface FlowCanvasProps {
  /** 服务端返回的 Definition 工件；草稿可能尚未通过校验 */
  definition: object;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  /**
   * 开启拖动、连线与右键菜单
   * @description 缺省为只读。只有调用方真的能承接改动（有草稿状态与保存入口）时才打开。
   */
  editable?: boolean;
  onMoveNode?: (nodeId: string, position: FlowNodePosition) => void;
  onResizeLoop?: (
    loopId: string,
    size: { width: number; height: number },
  ) => void;
  onToggleLoop?: (loopId: string) => void;
  onConnect?: (from: string, to: string, branch?: string) => void;
  onDeleteEdge?: (from: string, to: string, branch: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onDuplicateNode?: (nodeId: string) => void;
  onDisconnectAll?: (nodeId: string) => void;
  /** 从左侧面板拖入一种节点类型时的落点回调 */
  onDropNodeType?: (type: FlowNodeType, position: FlowNodePosition) => void;
  /** 节点 id → 供应商信息；用于在节点卡片角落渲染接入厂商 logo */
  nodeProviders?: ReadonlyMap<string, NodeProviderInfo>;
  /** 校验未通过的节点 id 集；有错的节点用 danger 边框高亮，与左栏红点互为双重信号 */
  errorNodeIds?: ReadonlySet<string>;
  /** 控制只读画布何时重新适配视口；同一键内编辑节点时不反复缩放 */
  fitViewKey?: string | number;
}

/**
 * Flow Definition 的画布
 * @param props Definition、选中节点与可选的编辑回调
 * @returns 返回画布或不可渲染时的说明
 * @description 外层包 ReactFlowProvider：把拖入落点从屏幕坐标换算成画布坐标要用
 * useReactFlow，而它必须在 Provider 内。
 */
export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function FlowCanvasInner({
  definition,
  selectedNodeId,
  onSelectNode,
  editable = false,
  onMoveNode,
  onResizeLoop,
  onToggleLoop,
  onConnect,
  onDeleteEdge,
  onDeleteNode,
  onDuplicateNode,
  onDisconnectAll,
  onDropNodeType,
  nodeProviders,
  errorNodeIds,
  fitViewKey,
}: FlowCanvasProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const lastFittedGraph = useRef<FlowGraph | string | number | null>(null);
  const [menu, setMenu] = useState<ContextTarget | null>(null);
  /** 连线模式：非空时点击另一个节点即完成从该节点出发的连线（右键「连线到…」进入） */
  const [connectSourceState, setConnectSource] = useState<string | null>(null);
  const [collapsedOverrides, setCollapsedOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(new Map());

  const parsed = useMemo(
    () => readDefinitionForCanvas(definition),
    [definition],
  );
  const graph = useMemo(
    () =>
      parsed.ok ? toFlowGraph(parsed.definition, collapsedOverrides) : null,
    [parsed, collapsedOverrides],
  );

  const toggleLoop = (loopId: string) => {
    const projected = graph?.nodes.find((node) => node.id === loopId);
    if (!projected) return;
    if (editable && onToggleLoop) {
      onToggleLoop(loopId);
      return;
    }
    setCollapsedOverrides((current) => {
      const next = new Map(current);
      next.set(loopId, !(projected.collapsed ?? false));
      return next;
    });
  };

  // React Flow 必须自己持有位置状态：完全受控又不接 onNodesChange 时，节点位置每帧都被
  // prop 钉回原处，拖动看不到任何移动——这就是「节点没随拖动移动」的原因。
  // 这里让它在拖动期间自持，拖完由 onNodeDragStop 提交给草稿，草稿变化再经下面的同步回灌。
  const [rfNodes, setRfNodes] = useState<Node<FlowNodeData>[]>([]);
  const [syncedGraph, setSyncedGraph] = useState<FlowGraph | null>(null);
  if (graph !== syncedGraph) {
    setSyncedGraph(graph);
    setRfNodes(
      (graph?.nodes ?? []).map((node) => ({
        id: node.id,
        type: "flowNode",
        position: node.position,
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.hidden ? { hidden: true } : {}),
        ...(node.width !== undefined ? { width: node.width } : {}),
        ...(node.height !== undefined ? { height: node.height } : {}),
        ...(node.type === "loop"
          ? {
              style: {
                width: node.width,
                height: node.height,
                zIndex: 0,
              },
            }
          : { style: { zIndex: 1 } }),
        data: {
          nodeId: node.id,
          ...(node.name ? { nodeName: node.name } : {}),
          ...(node.description ? { nodeDescription: node.description } : {}),
          nodeType: node.type,
          selected: false,
          loopSummary: node.loopSummary,
          loopWarning: node.loopWarning,
          collapsed: node.collapsed,
          editable,
          onToggleLoop: toggleLoop,
          onResizeLoop,
        },
      })),
    );
  }

  // 选中态在渲染期贴上，不进 rfNodes 状态：否则改选中要重建整份节点数组，
  // 还会和拖动期间的位置状态互相覆盖
  // 连线模式的源节点被删（撤销/菜单）时自动退出模式：渲染期派生，不用 effect
  const connectSource =
    connectSourceState && rfNodes.some((node) => node.id === connectSourceState)
      ? connectSourceState
      : null;
  const nodes = useMemo(
    () =>
      rfNodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          selected: node.id === selectedNodeId,
          connectSource: node.id === connectSource,
          connectTarget:
            connectSource !== null &&
            node.id !== connectSource &&
            node.data.nodeType !== "start",
          // 供应商信息必须挂在这里而不是 rfNodes 同步块：capabilities 异步到达时
          // graph 身份不变、同步块不重跑，logo 会永远不出现
          provider: nodeProviders?.get(node.id),
          hasError: errorNodeIds?.has(node.id) ?? false,
        },
      })),
    [rfNodes, selectedNodeId, connectSource, nodeProviders, errorNodeIds],
  );

  // 连线模式下 Esc 取消
  useEffect(() => {
    if (!connectSource) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setConnectSource(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [connectSource]);

  useEffect(() => {
    if (!graph || graph.nodes.length === 0 || !nodesInitialized) {
      return;
    }
    const fitIdentity = fitViewKey ?? graph;
    if (lastFittedGraph.current === fitIdentity) {
      return;
    }
    lastFittedGraph.current = fitIdentity;
    void fitView({ padding: 0.18, duration: 180 });
  }, [fitView, fitViewKey, graph, nodesInitialized]);

  // 与选中节点相连的输入/输出边：整条流动（animated 的流动点）+ 主题色描边高光。
  // 选中态在渲染期贴上，不进状态，理由同节点 selected。
  const edges = useMemo<Edge[]>(
    () =>
      (graph?.edges ?? []).map((edge) => {
        const connectedToSelection =
          !!selectedNodeId &&
          (edge.source === selectedNodeId || edge.target === selectedNodeId);
        const isLoopReturn = edge.targetHandle === "loop-return";
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          label: edge.label || undefined,
          type: isLoopReturn ? "smoothstep" : undefined,
          animated: isLoopReturn || connectedToSelection,
          deletable: editable,
          style: connectedToSelection
            ? { stroke: "var(--lb-accent)", strokeWidth: 2 }
            : undefined,
        };
      }),
    [graph, editable, selectedNodeId],
  );

  if (!parsed.ok) {
    return (
      <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-6 text-center">
        <AlertTriangle className="h-5 w-5 text-[var(--lb-warning)]" />
        <p className="text-sm font-medium text-foreground">画布无法渲染</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {parsed.reason}
        </p>
        <p className="text-xs text-muted-foreground">
          JSON 编辑器仍可编辑；结构是否合法由「校验」按钮向服务端确认。
        </p>
      </div>
    );
  }

  return (
    <div
      className="relative h-full min-h-[420px] rounded-md border border-border"
      onDragOver={(event) => {
        if (!editable || !onDropNodeType) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        if (!editable || !onDropNodeType) return;
        event.preventDefault();
        const type = event.dataTransfer.getData(FLOW_NODE_DRAG_TYPE);
        if (!type) return;
        // 屏幕坐标换算成画布坐标，否则缩放或平移之后落点会偏
        onDropNodeType(
          type as FlowNodeType,
          screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        );
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={editable}
        nodesConnectable={editable}
        edgesFocusable={editable}
        elementsSelectable
        fitView
        proOptions={{ hideAttribution: false }}
        onNodesChange={(changes: NodeChange<Node<FlowNodeData>>[]) =>
          setRfNodes((current) => applyNodeChanges(changes, current))
        }
        onNodeClick={(_, node) => {
          setMenu(null);
          if (
            connectSource &&
            node.id !== connectSource &&
            node.data.nodeType !== "start"
          ) {
            // 连线模式：点击合法目标即完成连线，分支自动挑选逻辑在页面层共享
            onConnect?.(connectSource, node.id);
            setConnectSource(null);
          }
          onSelectNode?.(node.id);
        }}
        onPaneClick={() => {
          setMenu(null);
          setConnectSource(null);
          onSelectNode?.(null);
        }}
        onNodeDragStop={(_, node) => {
          const projected = graph?.nodes.find((item) => item.id === node.id);
          const parent = projected?.parentId
            ? graph?.nodes.find((item) => item.id === projected.parentId)
            : undefined;
          onMoveNode?.(
            node.id,
            parent
              ? {
                  x: parent.position.x + node.position.x,
                  y: parent.position.y + node.position.y,
                }
              : node.position,
          );
        }}
        onConnect={(connection) => {
          if (connection.source && connection.target) {
            onConnect?.(
              connection.source,
              connection.target,
              connection.sourceHandle ?? undefined,
            );
          }
        }}
        onNodeContextMenu={(event, node) => {
          if (!editable) return;
          event.preventDefault();
          setMenu({
            kind: "node",
            nodeId: node.id,
            nodeType: node.data.nodeType,
            edgeCount:
              graph?.edges.filter(
                (edge) => edge.source === node.id || edge.target === node.id,
              ).length ?? 0,
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onEdgeContextMenu={(event, edge) => {
          if (!editable) return;
          const projected = graph?.edges.find((item) => item.id === edge.id);
          if (!projected) return;
          event.preventDefault();
          setMenu({
            kind: "edge",
            from: projected.source,
            to: projected.target,
            branch: projected.branch,
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onEdgesDelete={(deleted) => {
          for (const edge of deleted) {
            const projected = graph?.edges.find((item) => item.id === edge.id);
            if (projected) {
              onDeleteEdge?.(
                projected.source,
                projected.target,
                projected.branch,
              );
            }
          }
        }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>

      {menu ? (
        <ContextMenu
          target={menu}
          onClose={() => setMenu(null)}
          onDeleteNode={onDeleteNode}
          onDeleteEdge={onDeleteEdge}
          onDuplicateNode={onDuplicateNode}
          onDisconnectAll={onDisconnectAll}
          onStartConnect={(nodeId) => setConnectSource(nodeId)}
        />
      ) : null}

      {connectSource ? (
        <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground shadow-md">
          <ArrowRightToLine className="h-3.5 w-3.5 text-primary" />
          连线模式：点击目标节点完成，Esc 取消 · 源
          <span className="font-mono text-muted-foreground">
            {connectSource}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 把菜单位置收进视口
 * @param x 鼠标屏幕横坐标
 * @param y 鼠标屏幕纵坐标
 * @param size 实测尺寸；未测量到时用估算值（首帧 hidden，同帧修正，用户看不到）
 * @returns 返回不会溢出视口的左上角坐标
 * @description 靠右/靠下时改成向左/向上展开，而不是让菜单被裁掉——被裁掉的那一半正好
 * 是动作按钮所在的位置，点不到。菜单项数量随目标类型变化（节点 4 项、边 1 项），
 * 尺寸必须实测，不能再写死估算。
 */
function fitMenuIntoViewport(
  x: number,
  y: number,
  size: { width: number; height: number } | null,
): { left: number; top: number } {
  const margin = 8;
  const width = size?.width ?? 200;
  const height = size?.height ?? 180;
  const maxLeft = window.innerWidth - width - margin;
  const maxTop = window.innerHeight - height - margin;
  return {
    left: Math.max(margin, Math.min(x, maxLeft)),
    top: Math.max(margin, Math.min(y, maxTop)),
  };
}

/** 菜单项：统一样式，危险动作用 danger 色，不可用时置灰。 */
function MenuItem({
  icon: Icon,
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
        danger
          ? "text-[var(--lb-danger)] hover:bg-[var(--lb-danger-soft)] focus-visible:bg-[var(--lb-danger-soft)]"
          : "text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
      )}
      onClick={onClick}
      role="menuitem"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/**
 * 画布上的右键菜单
 * @param props 目标、关闭与动作回调集
 * @returns 返回浮层菜单
 * @description Portal 到 body 后用 fixed 跟随鼠标屏幕坐标，避免 React Flow 的层叠上下文和
 * 指针处理影响菜单命中；按画布内坐标定位会在缩放后错位。
 * 靠近视口边缘时自动翻转（useLayoutEffect 同帧实测尺寸后修正），避免动作被裁到屏幕外。
 * 整屏透明遮罩负责「点别处即关闭」，避免菜单留在屏幕上。
 * start/end 唯一不可删也不可复制；end 没有出口，不出现「连线到…」。
 */
function ContextMenu({
  target,
  onClose,
  onDeleteNode,
  onDeleteEdge,
  onDuplicateNode,
  onDisconnectAll,
  onStartConnect,
}: {
  target: ContextTarget;
  onClose: () => void;
  onDeleteNode?: (nodeId: string) => void;
  onDeleteEdge?: (from: string, to: string, branch: string) => void;
  onDuplicateNode?: (nodeId: string) => void;
  onDisconnectAll?: (nodeId: string) => void;
  onStartConnect?: (nodeId: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{
    width: number;
    height: number;
  } | null>(null);
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (rect) {
      setMeasured({ width: rect.width, height: rect.height });
    }
  }, [target]);
  const position = fitMenuIntoViewport(target.x, target.y, measured);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onPointerDown={onClose} />
      <div
        ref={menuRef}
        className="fixed z-50 w-[200px] overflow-hidden rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md"
        style={{ ...position, visibility: measured ? "visible" : "hidden" }}
        role="menu"
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="truncate px-3 py-1 font-mono text-xs text-muted-foreground">
          {target.kind === "node"
            ? target.nodeId
            : `${target.from} → ${target.to}`}
        </div>
        {target.kind === "node" ? (
          <>
            {target.nodeType === "end" ? null : (
              <MenuItem
                icon={ArrowRightToLine}
                label="连线到…"
                onClick={() => {
                  onStartConnect?.(target.nodeId);
                  onClose();
                }}
              />
            )}
            {target.nodeType === "start" || target.nodeType === "end" ? null : (
              <MenuItem
                icon={Copy}
                label="复制节点"
                onClick={() => {
                  onDuplicateNode?.(target.nodeId);
                  onClose();
                }}
              />
            )}
            <MenuItem
              icon={Unplug}
              label="断开所有连线"
              disabled={target.edgeCount === 0}
              onClick={() => {
                onDisconnectAll?.(target.nodeId);
                onClose();
              }}
            />
            {target.nodeType === "start" || target.nodeType === "end" ? null : (
              <MenuItem
                icon={Trash2}
                label="删除节点"
                danger
                onClick={() => {
                  onClose();
                  onDeleteNode?.(target.nodeId);
                }}
              />
            )}
          </>
        ) : (
          <MenuItem
            icon={Trash2}
            label="删除这条连线"
            danger
            onClick={() => {
              onDeleteEdge?.(target.from, target.to, target.branch);
              onClose();
            }}
          />
        )}
      </div>
    </>,
    document.body,
  );
}
