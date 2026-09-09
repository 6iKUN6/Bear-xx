import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  GitBranch,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { confirm } from "@/components/confirm-dialog";
import {
  StreamTaskEventType,
  getStreamTaskEventLabel,
  type StreamTaskEventEnvelope,
} from "@litter-bear/types/protocol";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TraceViewer } from "@/components/trace-viewer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAgents,
  useAgentCapabilities,
  useAgentFlows,
  useDeleteTestSession,
  useTestSession,
  useTestSessions,
} from "@/hooks/queries";
import { streamAgentTest } from "@/api/stream";
import type {
  Agent,
  AgentFlow,
  ModelPresetOption,
  TestExecutionModelSnapshot,
  TestMessageExecution,
  TestSessionMessage,
} from "@/api/types";
import { cn } from "@/lib/utils";
import { formatTime, statusBadgeVariant } from "@/lib/format";

interface TimelineItem {
  key: string;
  label: string;
  detail?: string;
  tone: "info" | "success" | "warning" | "destructive";
}

/** 本地流式中的消息（完成后由会话详情 refetch 取代） */
interface PendingMessage {
  role: "user" | "assistant";
  content: string;
}

interface LiveExecution {
  taskId: string | null;
  flow: {
    flowId: string;
    flowVersionId: string;
    digest: string;
  } | null;
  models: Array<{ model: string; provider: string | null }>;
}

const EMPTY_LIVE_EXECUTION: LiveExecution = {
  taskId: null,
  flow: null,
  models: [],
};

const NON_TIMELINE = new Set<string>([
  StreamTaskEventType.MessageDelta,
  StreamTaskEventType.ToolCallDelta,
]);

export function AgentTestPage() {
  const queryClient = useQueryClient();
  const { data: agents } = useAgents();
  const { data: capabilities } = useAgentCapabilities();
  const { data: flows } = useAgentFlows();
  const { data: sessions, isLoading: sessionsLoading } = useTestSessions();
  const deleteSession = useDeleteTestSession();

  const [activeId, setActiveId] = useState<string | null>(null);
  const {
    data: detail,
    isLoading: detailLoading,
    refetch,
  } = useTestSession(activeId);

  const [agentId, setAgentId] = useState("");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [liveEvents, setLiveEvents] = useState<TimelineItem[]>([]);
  const [liveExecution, setLiveExecution] =
    useState<LiveExecution>(EMPTY_LIVE_EXECUTION);
  const [eventsOpen, setEventsOpen] = useState(true);
  /** 右面板显示历史消息 trace 时的来源消息 id；null = 显示 live 事件 */
  const [traceMessageId, setTraceMessageId] = useState<string | null>(null);
  const selectedAgentUnavailable = Boolean(
    agentId &&
    !(agents ?? []).some((agent) => agent.id === agentId && agent.enabled),
  );
  const selectedAgent = resolveSelectedAgent(agents ?? [], agentId);
  const selectedFlow = resolveSelectedFlow(
    flows ?? [],
    selectedAgent?.defaultFlowVersionId ?? null,
  );
  const selectedModel = resolveModel(
    capabilities?.modelPresets ?? [],
    selectedAgent?.defaultModelPresetId ?? null,
  );

  const handleRef = useRef<{ abort: () => void } | null>(null);
  const seqRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const messages = detail?.messages ?? [];
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending]);

  const pushEvent = (item: Omit<TimelineItem, "key">) => {
    seqRef.current += 1;
    setLiveEvents((prev) => [...prev, { ...item, key: `${seqRef.current}` }]);
  };

  const selectSession = (id: string | null) => {
    if (running) return;
    setActiveId(id);
    setPending([]);
    setLiveEvents([]);
    setLiveExecution(EMPTY_LIVE_EXECUTION);
    setTraceMessageId(null);
  };

  const handleDelete = async (id: string) => {
    if (!(await confirm({ description: "确定删除该测试会话？", danger: true })))
      return;
    await deleteSession.mutateAsync(id);
    if (activeId === id) selectSession(null);
    toast.success("已删除");
  };

  const send = () => {
    const content = input.trim();
    if (!content || running || selectedAgentUnavailable) return;
    setInput("");
    setRunning(true);
    setTraceMessageId(null);
    setLiveEvents([]);
    setLiveExecution(EMPTY_LIVE_EXECUTION);
    seqRef.current = 0;
    setPending([
      { role: "user", content },
      { role: "assistant", content: "" },
    ]);

    handleRef.current = streamAgentTest(
      {
        content,
        conversationId: activeId ?? undefined,
        agentId: agentId || undefined,
      },
      {
        onEvent: (eventName, data) => handleEvent(eventName, data),
        onError: (err) => {
          pushEvent({
            label: "错误",
            detail: err.message,
            tone: "destructive",
          });
          toast.error(err.message);
          finishRun();
        },
        onDone: () => finishRun(),
      },
    );
  };

  const handleEvent = (eventName: string, data: StreamTaskEventEnvelope) => {
    const payload = (data.payload ?? {}) as Record<string, unknown>;

    if (eventName === StreamTaskEventType.TaskCreated && data.conversationId) {
      // 新会话首轮：记住会话 id，续接与侧边栏都靠它
      setActiveId((prev) => prev ?? data.conversationId ?? null);
      setLiveExecution((previous) => ({
        ...previous,
        taskId: data.taskId,
      }));
      return;
    }
    if (eventName === StreamTaskEventType.MessageDelta) {
      const delta = (payload.delta as string) ?? "";
      if (delta) {
        setPending((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.role === "assistant"
              ? { ...m, content: m.content + delta }
              : m,
          ),
        );
      }
      return;
    }
    if (eventName === StreamTaskEventType.ConversationTitleUpdated) {
      // AI 标题已生成：刷新侧边栏会话列表即可看到新标题
      void queryClient.invalidateQueries({ queryKey: ["testSessions"] });
      pushEvent({
        label: getStreamTaskEventLabel(
          StreamTaskEventType.ConversationTitleUpdated,
        ),
        detail: (payload.title as string) || undefined,
        tone: "success",
      });
      return;
    }
    if (eventName === StreamTaskEventType.FlowRunStarted) {
      const flowId = readString(payload.flowId);
      const flowVersionId = readString(payload.flowVersionId);
      const digest = readString(payload.digest);
      if (flowId && flowVersionId && digest) {
        setLiveExecution((previous) => ({
          ...previous,
          taskId: previous.taskId ?? data.taskId,
          flow: { flowId, flowVersionId, digest },
        }));
      }
    }
    if (eventName === StreamTaskEventType.ModelCallStart) {
      const model = readString(payload.model);
      const provider = readString(payload.provider) || null;
      if (model) {
        setLiveExecution((previous) =>
          previous.models.some(
            (item) => item.model === model && item.provider === provider,
          )
            ? previous
            : {
                ...previous,
                taskId: previous.taskId ?? data.taskId,
                models: [...previous.models, { model, provider }],
              },
        );
      }
    }
    if (NON_TIMELINE.has(eventName)) return;

    const tone =
      eventName === StreamTaskEventType.TaskError
        ? "destructive"
        : eventName === StreamTaskEventType.TaskCompleted ||
            eventName === StreamTaskEventType.ToolCallDone ||
            eventName === StreamTaskEventType.MessageDone
          ? "success"
          : "info";
    pushEvent({
      label:
        getStreamTaskEventLabel(eventName as StreamTaskEventType) || eventName,
      detail: describeEvent(eventName, payload),
      tone,
    });
  };

  const finishRun = () => {
    setRunning(false);
    // 刷新会话详情与侧边栏；refetch 完成后再清本地 pending，避免消息闪断
    void Promise.all([refetch()]).then(() => setPending([]));
  };

  const stop = () => {
    handleRef.current?.abort();
    finishRun();
  };

  /** 右面板内容：历史消息 trace 或 live 事件 */
  const traceMessage = traceMessageId
    ? messages.find((m) => m.id === traceMessageId)
    : null;
  const panelItems = liveEvents;
  const traceTurn = traceMessage
    ? messages
        .slice(
          0,
          messages.findIndex((message) => message.id === traceMessage.id) + 1,
        )
        .filter((message) => message.role === "assistant").length
    : 0;

  return (
    <div className="flex h-[calc(100vh-8.5rem)] gap-4">
      {/* 左·会话侧边栏 */}
      <aside className="flex w-60 shrink-0 flex-col rounded-lg border border-border bg-card">
        <div className="border-b border-border p-3">
          <Button
            className="w-full"
            variant={activeId === null ? "default" : "outline"}
            size="sm"
            onClick={() => selectSession(null)}
            disabled={running}
          >
            <MessageSquarePlus className="h-4 w-4" />
            新测试会话
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sessionsLoading ? (
            <div className="space-y-2 p-1">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (sessions ?? []).length === 0 ? (
            <p className="p-3 text-center text-xs text-muted-foreground">
              暂无测试会话
            </p>
          ) : (
            (sessions ?? []).map((s) => (
              <div
                key={s.id}
                className={cn(
                  "group mb-1 cursor-pointer rounded-md border border-transparent px-3 py-2 transition-colors hover:bg-muted",
                  activeId === s.id && "border-border bg-accent",
                )}
                onClick={() => selectSession(s.id)}
              >
                <div className="flex items-center justify-between gap-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {s.title}
                  </p>
                  <button
                    className="hidden shrink-0 text-muted-foreground hover:text-[var(--lb-danger)] group-hover:block"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(s.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {s.lastMessage || "（空会话）"}
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {s.messageCount} 条 · {formatTime(s.updatedAt)}
                </p>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* 中·聊天区 */}
      <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-border bg-card">
        <div className="border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div className="w-44">
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger className="h-8" disabled={running}>
                  <SelectValue placeholder="默认智能体" />
                </SelectTrigger>
                <SelectContent>
                  {(agents ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id} disabled={!a.enabled}>
                      {a.name}
                      {a.enabled ? "" : "（已停用）"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="ml-auto text-xs text-muted-foreground">
              {activeId ? detail?.title : "新会话（发送后自动创建）"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setEventsOpen((o) => !o)}
              title={eventsOpen ? "收起事件面板" : "展开事件面板"}
            >
              {eventsOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </Button>
          </div>
          <CurrentConfiguration
            agent={selectedAgent}
            flow={selectedFlow}
            model={selectedModel}
          />
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {detailLoading && activeId ? (
            <div className="space-y-3">
              <Skeleton className="ml-auto h-10 w-1/2" />
              <Skeleton className="h-16 w-2/3" />
            </div>
          ) : messages.length === 0 && pending.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              选择智能体，输入消息开始测试；同一会话内多轮对话带记忆
            </div>
          ) : (
            <>
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  selected={traceMessageId === m.id}
                  onShowTrace={
                    m.role === "assistant" &&
                    (m.trace.length > 0 || m.execution)
                      ? () => {
                          setTraceMessageId(m.id);
                          setEventsOpen(true);
                        }
                      : undefined
                  }
                />
              ))}
              {pending.map((m, i) => (
                <PendingBubble key={`p${i}`} message={m} running={running} />
              ))}
            </>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="flex items-end gap-2 border-t border-border p-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="输入测试消息，Enter 发送 / Shift+Enter 换行"
            className="min-h-[3rem] flex-1 resize-none"
          />
          {running ? (
            <Button variant="outline" onClick={stop}>
              <Square className="h-4 w-4" />
              停止
            </Button>
          ) : (
            <Button
              onClick={send}
              disabled={!input.trim() || selectedAgentUnavailable}
            >
              <Send className="h-4 w-4" />
              发送
            </Button>
          )}
        </div>
      </section>

      {/* 右·事件面板 */}
      {eventsOpen ? (
        <aside className="flex w-[min(100%,36rem)] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Label className="text-sm">
              {traceMessage ? "消息执行轨迹" : "实时执行事件"}
            </Label>
            {traceMessage ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTraceMessageId(null)}
              >
                返回实时
              </Button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {traceMessage ? (
              <div className="space-y-4">
                {traceMessage.execution ? (
                  <ExecutionSnapshot execution={traceMessage.execution} />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    该历史消息没有可用的执行快照
                  </p>
                )}
                <TraceViewer
                  trace={traceMessage.trace}
                  turnLabel={`第 ${traceTurn} 轮`}
                />
              </div>
            ) : panelItems.length > 0 || liveExecution.taskId ? (
              <div className="space-y-4">
                <LiveExecutionSummary
                  execution={liveExecution}
                  flows={flows ?? []}
                />
                <ol className="relative space-y-3 border-l border-border pl-4">
                  {panelItems.map((item) => (
                    <li key={item.key} className="relative">
                      <span className="absolute -left-[1.3rem] top-1 h-2 w-2 rounded-full bg-primary" />
                      <Badge variant={item.tone}>{item.label}</Badge>
                      {item.detail ? (
                        <p className="mt-1 text-xs text-foreground/80">
                          {item.detail}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <p className="pt-8 text-center text-xs text-muted-foreground">
                {running ? "等待事件…" : "发送消息后实时展示执行过程"}
              </p>
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function MessageBubble({
  message,
  selected,
  onShowTrace,
}: {
  message: TestSessionMessage;
  selected: boolean;
  onShowTrace?: () => void;
}) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-lg px-4 py-2.5 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-background text-foreground",
          onShowTrace && "cursor-pointer hover:border-[var(--lb-accent)]",
          selected && "border-[var(--lb-accent)]",
        )}
        onClick={onShowTrace}
      >
        <p className="whitespace-pre-wrap break-words">
          {message.content || "（空回复）"}
        </p>
        {!isUser && (message.trace.length > 0 || message.execution) ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
            <Badge variant={statusBadgeVariant(message.status)}>
              {message.status}
            </Badge>
            {message.execution ? (
              <span className="text-[10px] text-muted-foreground">
                {message.execution.flow.name} v{message.execution.flow.version}
                {message.execution.agentDefaultModel
                  ? ` · ${modelSnapshotLabel(message.execution.agentDefaultModel)}`
                  : ""}
              </span>
            ) : null}
            <span className="text-[10px] text-muted-foreground">
              {message.trace.length > 0
                ? `${message.trace.length} 个轨迹项 · `
                : ""}
              点击查看执行详情
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PendingBubble({
  message,
  running,
}: {
  message: PendingMessage;
  running: boolean;
}) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-lg px-4 py-2.5 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-background text-foreground",
        )}
      >
        <p className="whitespace-pre-wrap break-words">
          {message.content || (running && !isUser ? "思考中…" : "")}
        </p>
      </div>
    </div>
  );
}

/**
 * 展示发送前会采用的智能体当前配置
 * @param agent 当前选择或系统默认的智能体
 * @param flow 与智能体绑定版本匹配的逻辑 Flow
 * @param model 智能体当前默认模型的展示元数据
 * @returns 返回紧凑的当前配置摘要
 * @description 该区域只表示现在的配置，不用于解释已完成的历史任务。
 */
function CurrentConfiguration({
  agent,
  flow,
  model,
}: {
  agent: Agent | null;
  flow: AgentFlow | null;
  model: ModelPresetOption | null;
}) {
  if (!agent) {
    return (
      <p className="mt-2 text-xs text-[var(--lb-warning)]">
        当前配置：没有可用的默认智能体
      </p>
    );
  }

  const flowLabel = !agent.defaultFlowVersionId
    ? "内置直接回复 Flow"
    : flow?.publishedVersion
      ? `${flow.name} v${flow.publishedVersion.version}`
      : `FlowVersion ${shortId(agent.defaultFlowVersionId)}`;
  const modelLabel = agent.defaultModelPresetId
    ? (model?.name ?? agent.defaultModelPresetId)
    : "默认模型未配置";

  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">当前配置</span>
      <span className="inline-flex min-w-0 items-center gap-1">
        <Bot className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{agent.name}</span>
      </span>
      <span className="inline-flex min-w-0 items-center gap-1">
        <GitBranch className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{flowLabel}</span>
      </span>
      <span className="truncate">默认模型：{modelLabel}</span>
    </div>
  );
}

/**
 * 展示一条历史 assistant 消息冻结的执行配置
 * @param execution 后端从关联测试任务构造的不可变执行快照
 * @returns 返回 Flow、默认模型和逐节点模型配置明细
 * @description 节点配置不等同于实际经过的分支，实际调用仍由下方轨迹表达。
 */
function ExecutionSnapshot({ execution }: { execution: TestMessageExecution }) {
  return (
    <section className="space-y-3 border-b border-border pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">本轮冻结配置</h3>
        <Badge variant={statusBadgeVariant(execution.taskStatus)}>
          {execution.taskStatus}
        </Badge>
      </div>
      <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">任务</dt>
        <dd className="break-all font-mono text-foreground">
          {execution.taskId}
        </dd>
        <dt className="text-muted-foreground">Flow</dt>
        <dd className="text-foreground">
          {execution.flow.name} v{execution.flow.version}
        </dd>
        <dt className="text-muted-foreground">版本 ID</dt>
        <dd className="break-all font-mono text-foreground">
          {execution.flow.versionId}
        </dd>
        <dt className="text-muted-foreground">digest</dt>
        <dd className="break-all font-mono text-foreground">
          {execution.flow.digest}
        </dd>
        <dt className="text-muted-foreground">Agent 默认</dt>
        <dd className="text-foreground">
          {execution.agentDefaultModel
            ? modelSnapshotLabel(execution.agentDefaultModel)
            : "未冻结默认模型"}
        </dd>
      </dl>
      <div>
        <p className="mb-1.5 text-xs font-medium text-foreground">
          节点模型配置
        </p>
        {execution.nodeModels.length > 0 ? (
          <ul className="space-y-1.5">
            {execution.nodeModels.map((item) => (
              <li
                key={item.nodeId}
                className="flex flex-wrap items-center gap-1.5 text-xs"
              >
                <Badge variant="outline">
                  {item.nodeName || item.nodeId} · {item.nodeType}
                </Badge>
                <span className="text-foreground">
                  {modelSnapshotLabel(item.model)}
                </span>
                <span className="text-muted-foreground">
                  {item.source === "explicit" ? "节点指定" : "继承 Agent 默认"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            没有可解析的模型节点配置；实际调用以轨迹为准
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * 汇总本轮 SSE 已观察到的真实执行身份
 * @param execution 当前流中已收到的任务、Flow 与模型调用信息
 * @param flows 当前 Flow 列表，仅用于把稳定 ID 翻译为显示名称和版本号
 * @returns 返回实时执行摘要；未收到的字段不做推断
 * @description 只消费现有 flow.run.started 和 model.call.start 事件，不新增协议字段。
 */
function LiveExecutionSummary({
  execution,
  flows,
}: {
  execution: LiveExecution;
  flows: AgentFlow[];
}) {
  const flow = execution.flow
    ? flows.find((item) => item.id === execution.flow?.flowId)
    : null;
  const publishedVersion = flow?.publishedVersion;
  const version =
    publishedVersion && publishedVersion.id === execution.flow?.flowVersionId
      ? publishedVersion.version
      : null;

  return (
    <section className="space-y-2 border-b border-border pb-4 text-xs">
      <h3 className="font-medium text-foreground">本轮实时观察</h3>
      <p className="text-muted-foreground">
        任务：
        <span className="font-mono text-foreground">{execution.taskId}</span>
      </p>
      {execution.flow ? (
        <p className="text-muted-foreground">
          Flow：
          <span className="text-foreground">
            {flow?.name ?? execution.flow.flowId}
            {version ? ` v${version}` : ""}
          </span>
        </p>
      ) : null}
      {execution.models.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">实际调用：</span>
          {execution.models.map((item) => (
            <Badge key={`${item.provider}:${item.model}`} variant="info">
              {item.provider ? `${item.provider} / ` : ""}
              {item.model}
            </Badge>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * 解析测试台实际选择的智能体
 * @param agents 管理端可见的智能体列表
 * @param agentId 选择器中的显式智能体 ID，空字符串表示使用默认智能体
 * @returns 返回匹配的显式智能体或默认智能体；均不存在时返回 null
 */
function resolveSelectedAgent(agents: Agent[], agentId: string): Agent | null {
  if (agentId) return agents.find((agent) => agent.id === agentId) ?? null;
  return agents.find((agent) => agent.isDefault) ?? null;
}

/**
 * 解析智能体绑定的已发布 Flow
 * @param flows 管理端 Flow 列表
 * @param versionId 智能体当前绑定的发布版本 ID
 * @returns 返回拥有该发布版本的逻辑 Flow；内置 Flow 或元数据缺失时返回 null
 */
function resolveSelectedFlow(
  flows: AgentFlow[],
  versionId: string | null,
): AgentFlow | null {
  if (!versionId) return null;
  return flows.find((flow) => flow.publishedVersion?.id === versionId) ?? null;
}

/**
 * 解析智能体默认模型的显示选项
 * @param models 当前可用模型能力列表
 * @param presetId 智能体默认模型的稳定业务 ID
 * @returns 返回匹配的模型选项；未配置或元数据缺失时返回 null
 */
function resolveModel(
  models: ModelPresetOption[],
  presetId: string | null,
): ModelPresetOption | null {
  if (!presetId) return null;
  return models.find((model) => model.id === presetId) ?? null;
}

/**
 * 生成人类可读的模型快照名称
 * @param model 历史任务冻结的模型预设及当前展示元数据
 * @returns 优先返回预设名称，并在不同名时附带底层模型名
 */
function modelSnapshotLabel(model: TestExecutionModelSnapshot): string {
  const label = model.name ?? model.presetId;
  return model.model && model.model !== label
    ? `${label} (${model.model})`
    : label;
}

/**
 * 缩短仅用于界面提示的稳定标识
 * @param value 完整稳定 ID
 * @returns 返回最多十二字符的显示文本，长 ID 带省略号
 */
function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

/**
 * 从 SSE 未知载荷中读取非空字符串
 * @param value 待检查的事件字段
 * @returns 返回去除首尾空白的字符串，非字符串返回空串
 */
function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 从事件 payload 提炼一行中文详情 */
function describeEvent(
  eventName: string,
  payload: Record<string, unknown>,
): string | undefined {
  const parts: string[] = [];
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");

  if (eventName === StreamTaskEventType.StrategySelected) {
    if (s(payload.mode)) parts.push(`策略 ${s(payload.mode)}`);
    if (s(payload.reason)) parts.push(s(payload.reason));
  } else if (
    eventName === StreamTaskEventType.ToolCallStart ||
    eventName === StreamTaskEventType.ToolCallDone ||
    eventName === StreamTaskEventType.ToolCallError
  ) {
    if (s(payload.name) || s(payload.toolName))
      parts.push(`工具 ${s(payload.name) || s(payload.toolName)}`);
    if (s(payload.summary)) parts.push(s(payload.summary));
  } else if (
    eventName === StreamTaskEventType.ModelCallStart ||
    eventName === StreamTaskEventType.ModelCallDone
  ) {
    if (s(payload.model)) parts.push(s(payload.model));
  } else if (eventName === StreamTaskEventType.MessageDone) {
    const metrics = payload.metrics as Record<string, unknown> | undefined;
    if (metrics) {
      const tokenUsage = metrics.tokenUsage as
        Record<string, unknown> | undefined;
      if (tokenUsage?.totalTokens)
        parts.push(`${tokenUsage.totalTokens} token`);
      if (metrics.toolCallCount != null)
        parts.push(`工具 ${metrics.toolCallCount as number} 次`);
      if (metrics.modelCallCount != null)
        parts.push(`模型 ${metrics.modelCallCount as number} 次`);
    }
  } else if (eventName === StreamTaskEventType.TaskError) {
    parts.push(s(payload.message) || "任务失败");
  }

  return parts.length ? parts.join(" · ") : undefined;
}
