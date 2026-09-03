import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
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
import { AlertTriangle, Trash2 } from "lucide-react";
import { AnimateIcon } from "@/components/animate-ui/icons/icon";
import { Play } from "@/components/animate-ui/icons/play";
import { Bot } from "@/components/animate-ui/icons/bot";
import { ClipboardList } from "@/components/animate-ui/icons/clipboard-list";
import { User } from "@/components/animate-ui/icons/user";
import { RefreshCw } from "@/components/animate-ui/icons/refresh-cw";
import { RotateCw } from "@/components/animate-ui/icons/rotate-cw";
import { CircleCheck } from "@/components/animate-ui/icons/circle-check";
import type { FlowNodeType } from "@litter-bear/types/agent-flow";
import { cn } from "@/lib/utils";
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
  nodeType: FlowNodeType;
  selected: boolean;
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
  Record<FlowNodeType, React.ComponentType<{ size?: number; className?: string }>>
> = {
  start: Play,
  end: CircleCheck,
  agent: Bot,
  plan: ClipboardList,
  approval: User,
  loop: RefreshCw,
  "plan-loop": RotateCw,
};

function FlowCanvasNode({ data }: NodeProps<Node<FlowNodeData>>) {
  const meta = nodeTypeMeta(data.nodeType);
  const Icon = NODE_TYPE_ICONS[data.nodeType];
  const AnimatedIcon = NODE_TYPE_ANIMATED_ICONS[data.nodeType];
  return (
    <div
      className={cn(
        "relative min-w-[168px] rounded-md border bg-background px-3 py-2 transition-all duration-200",
        data.selected
          ? "border-primary shadow-[0_0_0_3px_var(--lb-accent-soft),0_0_16px_var(--lb-accent-soft)]"
          : "border-border shadow-sm",
      )}
      title={meta.desc}
    >
      {data.nodeType === "start" ? null : data.nodeType === "loop" ? (
        <>
          <Handle id="loop-entry" type="target" position={Position.Left} />
          <Handle
            id="loop-return"
            type="target"
            position={Position.Top}
            className="!bg-[var(--lb-warning)]"
          />
          <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground">
            返回下一轮
          </span>
        </>
      ) : (
        <Handle
          type="target"
          position={Position.Left}
          className={cn(data.selected && "!bg-primary")}
        />
      )}
      <div className="flex items-center gap-1.5">
        {AnimatedIcon ? (
          <AnimateIcon animate={data.selected ? "path-loop" : false} loop>
            <AnimatedIcon
              size={14}
              className={cn(
                "transition-colors",
                data.selected ? "text-primary" : "text-muted-foreground",
              )}
            />
          </AnimateIcon>
        ) : Icon ? (
          <Icon
            className={cn(
              "h-3.5 w-3.5 transition-colors",
              data.selected ? "text-primary" : "text-muted-foreground",
            )}
          />
        ) : null}
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
      {data.nodeType === "end" ? null : data.nodeType === "loop" ? (
        <>
          <Handle
            id="again"
            type="source"
            position={Position.Right}
            style={{ top: "38%" }}
            className="!bg-primary"
          />
          <span className="absolute -right-10 top-[calc(38%-8px)] text-[10px] font-medium text-primary">
            again
          </span>
          <Handle
            id="done"
            type="source"
            position={Position.Right}
            style={{ top: "72%" }}
            className="!bg-[var(--lb-success)]"
          />
          <span className="absolute -right-9 top-[calc(72%-8px)] text-[10px] font-medium text-[var(--lb-success)]">
            done
          </span>
        </>
      ) : (
        <Handle
          id="default"
          type="source"
          position={Position.Right}
          className={cn(data.selected && "!bg-primary")}
        />
      )}
    </div>
  );
}

const NODE_TYPES = { flowNode: FlowCanvasNode } as const;

/** 拖入画布时携带节点类型的 dataTransfer 键。 */
export const FLOW_NODE_DRAG_TYPE = "application/lb-flow-node";

/** 右键菜单的目标；节点与边各有自己的删除语义。 */
type ContextTarget =
  | { kind: "node"; nodeId: string; x: number; y: number }
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
  onConnect?: (from: string, to: string, branch?: string) => void;
  onDeleteEdge?: (from: string, to: string, branch: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  /** 从左侧面板拖入一种节点类型时的落点回调 */
  onDropNodeType?: (type: FlowNodeType, position: FlowNodePosition) => void;
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
  onConnect,
  onDeleteEdge,
  onDeleteNode,
  onDropNodeType,
  fitViewKey,
}: FlowCanvasProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const lastFittedGraph = useRef<FlowGraph | string | number | null>(null);
  const [menu, setMenu] = useState<ContextTarget | null>(null);

  const parsed = useMemo(
    () => readDefinitionForCanvas(definition),
    [definition],
  );
  const graph = useMemo(
    () => (parsed.ok ? toFlowGraph(parsed.definition) : null),
    [parsed],
  );

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
        data: {
          nodeId: node.id,
          ...(node.name ? { nodeName: node.name } : {}),
          nodeType: node.type,
          selected: false,
        },
      })),
    );
  }

  // 选中态在渲染期贴上，不进 rfNodes 状态：否则改选中要重建整份节点数组，
  // 还会和拖动期间的位置状态互相覆盖
  const nodes = useMemo(
    () =>
      rfNodes.map((node) => ({
        ...node,
        data: { ...node.data, selected: node.id === selectedNodeId },
      })),
    [rfNodes, selectedNodeId],
  );

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
          onSelectNode?.(node.id);
        }}
        onPaneClick={() => {
          setMenu(null);
          onSelectNode?.(null);
        }}
        onNodeDragStop={(_, node) => onMoveNode?.(node.id, node.position)}
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
        />
      ) : null}
    </div>
  );
}

/** 右键菜单的估算尺寸，用于贴边时翻转方向。 */
const CONTEXT_MENU_SIZE = { width: 180, height: 68 } as const;

/**
 * 把菜单位置收进视口
 * @param x 鼠标屏幕横坐标
 * @param y 鼠标屏幕纵坐标
 * @returns 返回不会溢出视口的左上角坐标
 * @description 靠右/靠下时改成向左/向上展开，而不是让菜单被裁掉——被裁掉的那一半正好是
 * 删除按钮所在的位置，点不到。用估算尺寸而不是测量真实高度：菜单只有固定的一两项，
 * 为此引入测量会把简单问题复杂化；真加到多项时再换成测量。
 */
function fitMenuIntoViewport(
  x: number,
  y: number,
): { left: number; top: number } {
  const margin = 8;
  const maxLeft = window.innerWidth - CONTEXT_MENU_SIZE.width - margin;
  const maxTop = window.innerHeight - CONTEXT_MENU_SIZE.height - margin;
  return {
    left: Math.max(margin, Math.min(x, maxLeft)),
    top: Math.max(margin, Math.min(y, maxTop)),
  };
}

/**
 * 画布上的右键菜单
 * @param props 目标、关闭与删除回调
 * @returns 返回浮层菜单
 * @description 用 fixed 跟随鼠标屏幕坐标：画布内部有缩放与平移，按画布内坐标定位会在缩放后错位。
 * 靠近视口边缘时自动翻转，避免删除按钮被裁到屏幕外。
 * 整屏透明遮罩负责「点别处即关闭」，避免菜单留在屏幕上。
 */
function ContextMenu({
  target,
  onClose,
  onDeleteNode,
  onDeleteEdge,
}: {
  target: ContextTarget;
  onClose: () => void;
  onDeleteNode?: (nodeId: string) => void;
  onDeleteEdge?: (from: string, to: string, branch: string) => void;
}) {
  const position = fitMenuIntoViewport(target.x, target.y);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 w-[180px] overflow-hidden rounded-md border border-border bg-background py-1 shadow-md"
        style={position}
      >
        <div className="truncate px-3 py-1 font-mono text-xs text-muted-foreground">
          {target.kind === "node"
            ? target.nodeId
            : `${target.from} → ${target.to}`}
        </div>
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--lb-danger)] hover:bg-muted"
          onClick={() => {
            if (target.kind === "node") {
              onDeleteNode?.(target.nodeId);
            } else {
              onDeleteEdge?.(target.from, target.to, target.branch);
            }
            onClose();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {target.kind === "node" ? "删除节点" : "删除这条连线"}
        </button>
      </div>
    </>
  );
}
