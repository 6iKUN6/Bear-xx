import { create } from "zustand";
import {
  buildStreamFeedbackFromTrace,
  mergeStreamFeedbackEvent,
  toMessageStreamFeedback,
  type MessageRunMetrics,
  type MessageStreamEventFeedback,
  type MessageStreamFeedbackState,
  type StreamTaskEvent,
} from "@litter-bear/chat-core";
import {
  STREAM_TASK_EVENT_LABELS,
  TASK_ERROR_CATEGORY_LABELS,
  StreamTaskEventType,
  type ApprovalDecision,
  type ConversationTitleUpdatedPayload,
  type FlowApprovalPayload,
  type FlowRunResumedPayload,
  type FlowWaitingHumanPayload,
  type MessageDeltaPayload,
  type MessageDonePayload,
  type PlanReviewDecision,
  type StreamTaskEventEnvelope,
  type TaskErrorPayload,
} from "@litter-bear/types/protocol";
import { cancelStreamTask, getConversations } from "@/api/endpoints";
import {
  streamApproval,
  streamChatMessage,
  streamPlanReview,
  type ChatStreamHandlers,
  type StreamHandle,
} from "@/api/stream";
import type {
  Conversation,
  ConversationMessage,
  ResolvedApproval,
} from "@/api/types";
import type { ReasoningSelection } from "@litter-bear/types";

/** 发送一条消息的可选项：智能体、模型与思考设置 */
export interface SendOptions {
  /** 指定使用的智能体 id；不传则用会话默认 / 内置智能体 */
  agentId?: string | null;
  /** 本条消息选择的模型预设业务 ID */
  selectedModelPresetId?: string;
  /** 本轮思考设置（仅 direct Agent 可用） */
  reasoning?: ReasoningSelection;
  /** 创作助手显式指定会话，不改变普通对话的选中项。 */
  conversationId?: string | null;
  onConversationId?: (id: string) => void;
  onComplete?: (message: ConversationMessage) => void;
}

/**
 * 会话与消息：GET /conversations 拉取，POST /chat/message（SSE）发送并流式更新。
 * 执行轨迹（trace）与 HITL 审批卡复用 @litter-bear/chat-core 的折叠/构建逻辑：
 * 实时事件经 toMessageStreamFeedback 折叠进 message.streamFeedback，
 * 历史回显由 buildStreamFeedbackFromTrace(message.trace) 构建。
 */
interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  loading: boolean;
  /** 会话列表加载失败文案；null = 正常 */
  loadError: string | null;
  sending: boolean;
  activeMessageId: string | null;
  taskId: string | null;
  canceling: boolean;
  taskError: string | null;
  drafts: Record<string, string>;
  setDraft: (key: string, value: string) => void;
  cancel: () => Promise<void>;
  /** 审批提交中（禁用审批卡交互，避免重复提交） */
  approvalSubmitting: boolean;
  loadConversations: () => Promise<void>;
  setActive: (id: string | null) => void;
  send: (content: string, options?: SendOptions) => string | null;
  /** 展开 / 收起某条消息的执行轨迹 */
  toggleStreamFeedback: (messageId: string) => void;
  /** 提交工具审批决定（HITL），审批端点续跑同一任务 */
  submitApproval: (messageId: string, decision: ApprovalDecision) => void;
  /** 提交计划审批决定（HITL），计划审批端点续跑同一任务 */
  submitPlanReview: (messageId: string, decision: PlanReviewDecision) => void;
  /** 退出登录 / 清理本地会话态 */
  reset: () => void;
}

let localSeq = 0;
function localId(prefix: string) {
  localSeq += 1;
  return `local-${prefix}-${Date.now()}-${localSeq}`;
}

/**
 * 当前活动流的上下文：一次发送（及可能的审批续跑）共享同一条助手消息。
 * 桌面端同一时间只有一条活动流，用模块级引用即可，无需进 store。
 */
interface ActiveStreamContext {
  assistantMessageId: string;
  conversationId: string;
  options: SendOptions;
  handle?: StreamHandle;
  terminal: boolean;
  seen: Set<string>;
  taskId?: string;
  lastEventId?: string;
}
let activeStream: ActiveStreamContext | null = null;
let sessionEpoch = 0;
let loadSequence = 0;

function patchMessage(
  conversations: Conversation[],
  messageId: string,
  patch: (m: ConversationMessage) => ConversationMessage,
): Conversation[] {
  return conversations.map((c) =>
    c.messages.some((m) => m.id === messageId)
      ? {
          ...c,
          messages: c.messages.map((m) => (m.id === messageId ? patch(m) : m)),
        }
      : c,
  );
}

/** 线上信封 → chat-core 的 StreamTaskEvent 形状（data 即信封本体，含 payload） */
function toStreamTaskEvent(envelope: StreamTaskEventEnvelope): StreamTaskEvent {
  return {
    type: envelope.type,
    data: { ...envelope, type: envelope.type },
    rawData: JSON.stringify(envelope),
  };
}

/** 同一逻辑步骤（工具 / Flow 节点生命周期）按 id 或内容指纹折叠进同一条反馈 */
function isSameFeedbackStep(
  event: MessageStreamEventFeedback,
  nextEvent: MessageStreamEventFeedback,
) {
  return (
    event.id === nextEvent.id ||
    (event.type === nextEvent.type &&
      event.title === nextEvent.title &&
      event.detail === nextEvent.detail)
  );
}

function upsertFeedbackEvent(
  events: MessageStreamEventFeedback[],
  nextEvent: MessageStreamEventFeedback,
) {
  const matchedIndex = events.findIndex((event) =>
    isSameFeedbackStep(event, nextEvent),
  );
  if (matchedIndex < 0) {
    return [...events, nextEvent];
  }
  return events.map((event, index) =>
    index === matchedIndex ? mergeStreamFeedbackEvent(event, nextEvent) : event,
  );
}

function applyFeedbackEvent(
  message: ConversationMessage,
  event: MessageStreamEventFeedback,
): ConversationMessage {
  const prev: MessageStreamFeedbackState = message.streamFeedback ?? {
    events: [],
    expanded: false,
  };
  return {
    ...message,
    streamFeedback: {
      ...prev,
      current: event,
      events: upsertFeedbackEvent(prev.events, event),
    },
  };
}

/** 历史回显：助手消息有 trace 但还没有 streamFeedback 时，从 trace 构建折叠轨迹 */
function withHistoryFeedback(
  message: ConversationMessage,
): ConversationMessage {
  if (
    message.role !== "assistant" ||
    message.streamFeedback ||
    !message.trace?.length
  ) {
    return message;
  }
  const streamFeedback = buildStreamFeedbackFromTrace(message.trace);
  return streamFeedback ? { ...message, streamFeedback } : message;
}

export const useChatStore = create<ChatState>((set, get) => {
  const findMessage = (id: string) =>
    get()
      .conversations.flatMap((c) => c.messages)
      .find((m) => m.id === id);
  function patch(
    id: string,
    update: (message: ConversationMessage) => ConversationMessage,
  ) {
    set((state) => ({
      conversations: patchMessage(state.conversations, id, update),
    }));
  }
  function finish(context: ActiveStreamContext) {
    if (activeStream !== context) return;
    const message = findMessage(context.assistantMessageId);
    activeStream = null;
    set({
      sending: false,
      approvalSubmitting: false,
      activeMessageId: null,
      taskId: null,
      canceling: false,
    });
    if (message) context.options.onComplete?.(message);
  }
  // 普通对话、创作助手与审批续跑共用同一事件处理，保持工具/审批行为一致。
  function handlers(context: ActiveStreamContext): ChatStreamHandlers {
    const id = context.assistantMessageId;
    return {
      onEvent(event, frameId) {
        if (activeStream !== context) return;
        if (frameId) {
          if (context.seen.has(frameId)) return;
          context.seen.add(frameId);
          context.lastEventId = frameId;
        }
        if (event.taskId) {
          context.taskId = event.taskId;
          set({ taskId: event.taskId });
        }
        const remoteId = event.conversationId;
        if (remoteId && remoteId !== context.conversationId) {
          const previousId = context.conversationId;
          context.conversationId = remoteId;
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === previousId ? { ...c, id: remoteId } : c,
            ),
            activeId: state.activeId === previousId ? remoteId : state.activeId,
            drafts: {
              ...state.drafts,
              [remoteId]: state.drafts[previousId] ?? "",
            },
          }));
          context.options.onConversationId?.(remoteId);
        }
        const feedback = toMessageStreamFeedback(toStreamTaskEvent(event));
        if (feedback)
          patch(id, (message) => applyFeedbackEvent(message, feedback));
        switch (event.type) {
          case StreamTaskEventType.MessageDelta: {
            const delta = (event.payload as MessageDeltaPayload | undefined)
              ?.delta;
            if (delta) patch(id, (m) => ({ ...m, content: m.content + delta }));
            break;
          }
          case StreamTaskEventType.ConversationTitleUpdated: {
            const payload = event.payload as
              ConversationTitleUpdatedPayload | undefined;
            if (!payload) break;
            set((state) => ({
              conversations: state.conversations.map((c) =>
                c.id === payload.conversationId
                  ? { ...c, title: payload.title }
                  : c,
              ),
            }));
            break;
          }
          case StreamTaskEventType.FlowWaitingHuman: {
            // Flow 是唯一编排路径：工具审批与计划审批都以 flow.waiting_human 下发，
            // approvalId 是提交决定时必须回传的审批事实标识。
            const payload = event.payload as
              FlowWaitingHumanPayload | undefined;
            if (!payload) break;
            patch(id, (m) => ({ ...m, pendingApproval: payload }));
            set({ approvalSubmitting: false });
            break;
          }
          case StreamTaskEventType.FlowRunResumed: {
            const payload = event.payload as FlowRunResumedPayload | undefined;
            if (payload?.reason !== "approval") break;
            patch(id, (m) => ({ ...m, pendingApproval: undefined }));
            set({ approvalSubmitting: false });
            break;
          }
          case StreamTaskEventType.MessageDone: {
            context.terminal = true;
            const payload = event.payload as MessageDonePayload | undefined;
            patch(id, (m) => ({
              ...m,
              status: "done",
              content: payload?.content ?? m.content,
              metrics:
                (payload?.metrics as MessageRunMetrics | undefined) ??
                m.metrics,
            }));
            break;
          }
          case StreamTaskEventType.TaskCompleted:
            context.terminal = true;
            patch(id, (m) => ({
              ...m,
              status: m.status === "error" ? "error" : "done",
            }));
            break;
          case StreamTaskEventType.TaskCanceled:
            context.terminal = true;
            patch(id, (m) => ({
              ...m,
              status: "done",
              canceled: true,
              pendingApproval: undefined,
            }));
            break;
          case StreamTaskEventType.TaskError: {
            context.terminal = true;
            const payload = event.payload as TaskErrorPayload | undefined;
            patch(id, (m) => ({
              ...m,
              status: "error",
              pendingApproval: undefined,
              errorMessage: payload
                ? TASK_ERROR_CATEGORY_LABELS[payload.category]
                : STREAM_TASK_EVENT_LABELS[StreamTaskEventType.TaskError],
            }));
            break;
          }
        }
      },
      onError(error) {
        if (activeStream !== context) return;
        patch(id, (m) => ({
          ...m,
          status: "error",
          pendingApproval: undefined,
          errorMessage: error.message,
        }));
        finish(context);
      },
      onDone() {
        if (activeStream !== context) return;
        if (findMessage(id)?.pendingApproval) return;
        if (!context.terminal)
          patch(id, (m) => ({
            ...m,
            status: "error",
            errorMessage: "连接已结束，但未收到完成确认，请检查会话后重试。",
          }));
        finish(context);
      },
    };
  }
  /**
   * 提交审批决定并接续同一条助手消息的流
   * @param resolve 按审批类型生成本地结论；类型与提交入口不符时返回 null 并放弃提交
   * @description 先中止仍挂着的等待流，再由审批端点从 lastEventId 续推；本地先把卡片收敛为结论，
   * 决定被服务端拒绝时由 onError 把消息置为错误态，不会假装已经通过。
   */
  function resumeWithDecision(
    messageId: string,
    resolve: (approval: FlowApprovalPayload) => ResolvedApproval | null,
    open: (
      taskId: string,
      approvalId: string,
      lastEventId: string | undefined,
      handlers: ChatStreamHandlers,
    ) => StreamHandle,
  ) {
    const context = activeStream;
    const pending = findMessage(messageId)?.pendingApproval;
    if (
      !context?.taskId ||
      context.assistantMessageId !== messageId ||
      get().approvalSubmitting ||
      !pending
    )
      return;
    const resolvedApproval = resolve(pending.approval);
    if (!resolvedApproval) return;
    context.handle?.abort();
    set({ approvalSubmitting: true });
    patch(messageId, (m) => ({
      ...m,
      pendingApproval: undefined,
      resolvedApproval,
    }));
    context.handle = open(
      context.taskId,
      pending.approvalId,
      context.lastEventId,
      handlers(context),
    );
  }
  return {
    conversations: [],
    activeId: null,
    loading: false,
    loadError: null,
    sending: false,
    activeMessageId: null,
    taskId: null,
    canceling: false,
    taskError: null,
    approvalSubmitting: false,
    drafts: {},
    setDraft(key, value) {
      set({ drafts: { ...get().drafts, [key]: value } });
    },
    async loadConversations() {
      const epoch = sessionEpoch;
      const sequence = ++loadSequence;
      set({ loading: true, loadError: null });
      try {
        const remote = await getConversations();
        if (epoch !== sessionEpoch || sequence !== loadSequence) return;
        // 刷新目录时保留本机尚在进行的消息与局部错误，不覆盖活动流。
        const local = get().conversations.filter((c) =>
          c.messages.some((m) => m.id.startsWith("local-")),
        );
        const conversations = [
          ...local,
          ...remote.filter((c) => !local.some((item) => item.id === c.id)),
        ]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((c) => ({
            ...c,
            messages: c.messages.map(withHistoryFeedback),
          }));
        set({ conversations, loading: false });
      } catch (error) {
        if (epoch !== sessionEpoch || sequence !== loadSequence) return;
        set({
          loading: false,
          loadError: error instanceof Error ? error.message : "会话加载失败",
        });
      }
    },
    setActive(id) {
      set({ activeId: id });
    },
    toggleStreamFeedback(id) {
      patch(id, (m) =>
        m.streamFeedback
          ? {
              ...m,
              streamFeedback: {
                ...m.streamFeedback,
                expanded: !m.streamFeedback.expanded,
              },
            }
          : m,
      );
    },
    send(content, options = {}) {
      const text = content.trim();
      if (!text || get().sending) return null;
      if (text.length > 20000) {
        set({ taskError: "单条消息不能超过 20,000 字符。" });
        return null;
      }
      const explicitConversation = options.conversationId !== undefined;
      const conversationId = explicitConversation
        ? options.conversationId
        : get().activeId;
      const draftId = conversationId ?? localId("c");
      const userMessage: ConversationMessage = {
        id: localId("u"),
        role: "user",
        content: text,
        status: "done",
        createdAt: Date.now(),
      };
      const assistantMessage: ConversationMessage = {
        id: localId("a"),
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: Date.now(),
      };
      set((state) => {
        const existing = state.conversations.find((c) => c.id === draftId);
        const conversation: Conversation = existing ?? {
          id: draftId,
          title: text.slice(0, 18),
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        return {
          conversations: [
            {
              ...conversation,
              updatedAt: Date.now(),
              messages: [
                ...conversation.messages,
                userMessage,
                assistantMessage,
              ],
            },
            ...state.conversations.filter((c) => c.id !== draftId),
          ],
          activeId: explicitConversation ? state.activeId : draftId,
          sending: true,
          activeMessageId: assistantMessage.id,
          taskId: null,
          taskError: null,
        };
      });
      const context: ActiveStreamContext = {
        assistantMessageId: assistantMessage.id,
        conversationId: draftId,
        options,
        terminal: false,
        seen: new Set(),
      };
      activeStream = context;
      options.onConversationId?.(draftId);
      context.handle = streamChatMessage(
        {
          conversationId: conversationId?.startsWith("local-")
            ? undefined
            : (conversationId ?? undefined),
          content: text,
          agentId: options.agentId ?? undefined,
          selectedModelPresetId: options.selectedModelPresetId,
          reasoning: options.reasoning,
        },
        handlers(context),
      );
      return assistantMessage.id;
    },
    submitApproval(messageId, decision) {
      resumeWithDecision(
        messageId,
        (approval) =>
          approval.kind === "tool"
            ? { kind: "tool", payload: approval, decision: decision.decision }
            : null,
        (taskId, approvalId, lastEventId, h) =>
          streamApproval(taskId, approvalId, decision, lastEventId, h),
      );
    },
    submitPlanReview(messageId, decision) {
      resumeWithDecision(
        messageId,
        (approval) =>
          approval.kind === "plan-review"
            ? {
                kind: "plan-review",
                payload: approval,
                decision: decision.decision,
              }
            : null,
        (taskId, approvalId, lastEventId, h) =>
          streamPlanReview(taskId, approvalId, decision, lastEventId, h),
      );
    },
    async cancel() {
      const context = activeStream;
      if (!context?.taskId || get().canceling) return;
      set({ canceling: true, taskError: null });
      try {
        const result = await cancelStreamTask(context.taskId);
        if (activeStream !== context) return;
        if (result.status !== "canceled")
          throw new Error("任务状态已变化，尚未确认取消，请等待当前结果。");
        context.handle?.abort();
        patch(context.assistantMessageId, (m) => ({
          ...m,
          status: "done",
          canceled: true,
          pendingApproval: undefined,
        }));
        finish(context);
      } catch (error) {
        if (activeStream !== context) return;
        set({
          canceling: false,
          taskError: error instanceof Error ? error.message : "停止失败",
        });
      }
    },
    reset() {
      activeStream?.handle?.abort();
      activeStream = null;
      sessionEpoch += 1;
      set({
        conversations: [],
        activeId: null,
        loading: false,
        loadError: null,
        sending: false,
        activeMessageId: null,
        taskId: null,
        taskError: null,
        canceling: false,
        approvalSubmitting: false,
        drafts: {},
      });
    },
  };
});
