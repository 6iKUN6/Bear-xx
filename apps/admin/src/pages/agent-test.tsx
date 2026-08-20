import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
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
  useDeleteTestSession,
  useModelPresets,
  useTestSession,
  useTestSessions,
} from "@/hooks/queries";
import { streamAgentTest } from "@/api/stream";
import type { TestSessionMessage } from "@/api/types";
import { cn } from "@/lib/utils";
import { formatTime, statusBadgeVariant } from "@/lib/format";
import { capabilityMeta } from "@/lib/model-preset-meta";

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

const NON_TIMELINE = new Set<string>([
  StreamTaskEventType.MessageDelta,
  StreamTaskEventType.ToolCallDelta,
]);

export function AgentTestPage() {
  const queryClient = useQueryClient();
  const { data: agents } = useAgents();
  const { data: models } = useModelPresets();
  const { data: sessions, isLoading: sessionsLoading } = useTestSessions();
  const deleteSession = useDeleteTestSession();

  const [activeId, setActiveId] = useState<string | null>(null);
  const {
    data: detail,
    isLoading: detailLoading,
    refetch,
  } = useTestSession(activeId);

  const [agentId, setAgentId] = useState("");
  const [modelPreset, setModelPreset] = useState("");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [liveEvents, setLiveEvents] = useState<TimelineItem[]>([]);
  const [eventsOpen, setEventsOpen] = useState(true);
  /** 右面板显示历史消息 trace 时的来源消息 id；null = 显示 live 事件 */
  const [traceMessageId, setTraceMessageId] = useState<string | null>(null);

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
    setTraceMessageId(null);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("确定删除该测试会话？")) return;
    await deleteSession.mutateAsync(id);
    if (activeId === id) selectSession(null);
    toast.success("已删除");
  };

  const send = () => {
    const content = input.trim();
    if (!content || running) return;
    setInput("");
    setRunning(true);
    setTraceMessageId(null);
    setLiveEvents([]);
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
        modelPreset: modelPreset || undefined,
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
        <div className="flex items-center gap-2 border-b border-border p-3">
          <div className="w-44">
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="h-8">
                <SelectValue placeholder="默认智能体" />
              </SelectTrigger>
              <SelectContent>
                {(agents ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-52">
            <Select value={modelPreset} onValueChange={setModelPreset}>
              <SelectTrigger className="h-8">
                <SelectValue placeholder="用 agent 配置的模型" />
              </SelectTrigger>
              <SelectContent>
                {(models ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.presetId}>
                    {m.name} · {capabilityMeta(m.capability).name}
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
                    m.role === "assistant" && m.trace.length > 0
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
            <Button onClick={send} disabled={!input.trim()}>
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
              <TraceViewer
                trace={traceMessage.trace}
                turnLabel={`第 ${traceTurn} 轮`}
                className="h-full"
              />
            ) : panelItems.length > 0 ? (
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
        {!isUser && message.trace.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
            <Badge variant={statusBadgeVariant(message.status)}>
              {message.status}
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              {message.trace.length} 个节点 · 点击查看轨迹
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
