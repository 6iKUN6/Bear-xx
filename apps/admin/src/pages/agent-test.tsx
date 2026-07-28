import { useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import {
  StreamTaskEventType,
  getStreamTaskEventLabel,
  type StreamTaskEventEnvelope,
} from "@litter-bear/types/protocol";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/kpi-card";
import { useAgents, useModelPresets } from "@/hooks/queries";
import { streamAgentTest } from "@/api/stream";

interface TimelineItem {
  key: string;
  eventName: string;
  label: string;
  detail?: string;
  tone: "info" | "success" | "warning" | "destructive";
}

const NON_TIMELINE = new Set<string>([
  StreamTaskEventType.MessageDelta,
  StreamTaskEventType.ToolCallDelta,
]);

export function AgentTestPage() {
  const { data: agents } = useAgents();
  const { data: models } = useModelPresets();
  const [agentId, setAgentId] = useState<string>("");
  const [modelPreset, setModelPreset] = useState<string>("");
  const [content, setContent] = useState("");
  const [running, setRunning] = useState(false);
  const [reply, setReply] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const handleRef = useRef<{ abort: () => void } | null>(null);
  const seqRef = useRef(0);

  const push = (item: Omit<TimelineItem, "key">) => {
    seqRef.current += 1;
    setTimeline((prev) => [...prev, { ...item, key: `${seqRef.current}` }]);
  };

  const start = () => {
    if (!content.trim() || running) return;
    setReply("");
    setTimeline([]);
    seqRef.current = 0;
    setRunning(true);

    handleRef.current = streamAgentTest(
      {
        content: content.trim(),
        agentId: agentId || undefined,
        modelPreset: modelPreset || undefined,
      },
      {
        onEvent: (eventName, data) => handleEvent(eventName, data),
        onError: (err) => {
          push({
            eventName: "error",
            label: "错误",
            detail: err.message,
            tone: "destructive",
          });
          setRunning(false);
        },
        onDone: () => setRunning(false),
      },
    );
  };

  const handleEvent = (eventName: string, data: StreamTaskEventEnvelope) => {
    const payload = (data.payload ?? {}) as Record<string, unknown>;

    if (eventName === StreamTaskEventType.MessageDelta) {
      const delta = (payload.delta as string) ?? "";
      if (delta) setReply((r) => r + delta);
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

    push({
      eventName,
      label:
        getStreamTaskEventLabel(eventName as StreamTaskEventType) || eventName,
      detail: describe(eventName, payload, data),
      tone,
    });
  };

  const stop = () => {
    handleRef.current?.abort();
    setRunning(false);
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>测试输入</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>智能体</Label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger>
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
          <div className="space-y-1.5">
            <Label>模型预设（可选，覆盖 agent）</Label>
            <Select value={modelPreset} onValueChange={setModelPreset}>
              <SelectTrigger>
                <SelectValue placeholder="用 agent 配置" />
              </SelectTrigger>
              <SelectContent>
                {(models ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.presetId}>
                    {m.name}（{m.presetId}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>输入内容</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              placeholder="深圳今天天气怎么样"
            />
          </div>
          <div className="flex gap-2">
            {running ? (
              <Button variant="outline" onClick={stop}>
                <Square className="h-4 w-4" />
                停止
              </Button>
            ) : (
              <Button onClick={start} disabled={!content.trim()}>
                <Send className="h-4 w-4" />
                发送测试
              </Button>
            )}
          </div>

          {reply ? (
            <div className="rounded-md border border-border bg-muted p-3">
              <p className="mb-1 text-xs text-muted-foreground">助手回复</p>
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {reply}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>执行事件</CardTitle>
        </CardHeader>
        <CardContent>
          {timeline.length > 0 ? (
            <ol className="relative space-y-3 border-l border-border pl-4">
              {timeline.map((item) => (
                <li key={item.key} className="relative">
                  <span className="absolute -left-[1.3rem] top-1 h-2 w-2 rounded-full bg-primary" />
                  <div className="flex items-center gap-2">
                    <Badge variant={item.tone}>{item.label}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {item.eventName}
                    </span>
                  </div>
                  {item.detail ? (
                    <p className="mt-1 text-xs text-foreground/80">
                      {item.detail}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState text={running ? "等待事件…" : "发送测试后在此实时展示"} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** 从事件 payload 提炼一行中文详情 */
function describe(
  eventName: string,
  payload: Record<string, unknown>,
  data: StreamTaskEventEnvelope,
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
        | Record<string, unknown>
        | undefined;
      if (tokenUsage?.totalTokens) parts.push(`${tokenUsage.totalTokens} token`);
      if (metrics.toolCallCount != null)
        parts.push(`工具 ${metrics.toolCallCount as number} 次`);
      if (metrics.modelCallCount != null)
        parts.push(`模型 ${metrics.modelCallCount as number} 次`);
    }
  } else if (eventName === StreamTaskEventType.TaskError) {
    parts.push(s(data.payload && (payload.message as string)) || "任务失败");
  }

  return parts.length ? parts.join(" · ") : undefined;
}
