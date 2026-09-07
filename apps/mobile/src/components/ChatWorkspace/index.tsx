import { useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { View } from "@tarojs/components";
import { useDidHide } from "@tarojs/taro";
import type {
  ApprovalDecision,
  ApprovalRequiredPayload,
  PlanReviewDecision,
  PlanReviewRequiredPayload,
} from "@litter-bear/types/protocol";
import MessageList from "../MessageList";
import ChatInput from "../ChatInput";
import type { ChatImageAttachment, ChatInputHandle } from "../ChatInput";
import MemberBar from "../MemberBar";
import NavBar from "../NavBar";
import PageShell from "../PageShell";
import { useChatStore } from "../../store/chatStore";
import { useAgentStore } from "../../store/agentStore";
import { findAgent, resolveAgentName } from "../../utils/agent";
import { useChatStream } from "../../hooks/useChatStream";
import { toMessageStreamFeedback } from "../../utils/streamFeedback";
import { streamTaskService } from "../../services/stream";
import { ApiRequestError } from "../../api/request";
import {
  modelSelectionFingerprint,
  type AgentModelSelection,
} from "../../services/agent-model-selection";
import type {
  StreamTaskEvent,
  StreamTaskLifecycle,
} from "../../services/stream";
import {
  clearPendingTask,
  getPendingTask,
  savePendingTask,
} from "../../services/stream/pending-task";

let idCounter = Date.now();
function genMsgId(): string {
  return "msg_" + ++idCounter;
}

/** 空会话占位插槽的可用动作 */
export interface ChatWorkspaceEmptySlotActions {
  /** 把文本填进输入框（不发送），供开场提示卡等入口使用 */
  setDraft: (text: string) => void;
}

interface ChatWorkspaceProps {
  /** 指定会话 id（chat 页路由参数用）；不传则跟随 store 的 currentConversation */
  conversationId?: string;
  /** 导航栏左槽（首页的历史抽屉按钮等）；不传则按 showBack 渲染返回键 */
  navLeft?: ReactNode;
  showBack?: boolean;
  /** 无消息时渲染的占位内容（开场提示卡等） */
  renderEmpty?: (actions: ChatWorkspaceEmptySlotActions) => ReactNode;
}

/**
 * 聊天工作台（页面级共享组件）
 * @description 完整的对话交互：消息列表、群成员条、@ 提及输入栏、审批卡、
 * SSE 流式接线与标题实时更新。首页直显最近对话，独立 chat 页保留给深链入口；
 * 两者共用相同的消息与输入区，不在聊天页渲染全局导航。
 */
export default function ChatWorkspace({
  conversationId,
  navLeft,
  showBack = false,
  renderEmpty,
}: ChatWorkspaceProps) {
  const {
    abort,
    cancel,
    sendMessage,
    submitApproval,
    submitPlanReview,
    resume,
  } = useChatStream();

  const {
    currentConversation,
    setCurrentConversation,
    ensureDraftConversation,
    replaceConversationId,
    updateConversationTitle,
    updateConversationModelSelection,
    addMessage,
    updateMessageContent,
    setMessageContent,
    updateMessageMetrics,
    updateMessageStatus,
    updateMessageSpeaker,
    updateMessageStreamEvent,
    toggleMessageStreamFeedback,
    setMessageApproval,
    resolveMessageApproval,
    setMessagePlanReview,
    upsertMessageOrder,
    persistConversations,
  } = useChatStore();

  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  /** 每个会话每次挂载只做一次续接探测，避免消息更新反复触发 */
  const resumeProbedRef = useRef<Set<string>>(new Set());
  /** 上一次的会话 id，用于区分「换会话」与「草稿 id 被替换成真实 id」 */
  const lastConversationIdRef = useRef<string | undefined>(undefined);
  const agents = useAgentStore((state) => state.agents);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const ensureAgents = useAgentStore((state) => state.ensureAgents);

  // 群聊气泡头像与 @ 候选都只能由智能体列表解析（消息里只存 agentId），
  // 冷启动首屏直达群聊时列表可能还是空的，这里兜一次。
  useEffect(() => {
    void ensureAgents();
  }, [ensureAgents]);

  // 会话形态：GROUP/SINGLE 来自服务端；本地草稿与旧数据按未定型（flex）处理
  const conversationMode =
    currentConversation?.type === "GROUP"
      ? ("group" as const)
      : currentConversation?.type === "SINGLE"
        ? ("single" as const)
        : ("flex" as const);

  // 可 @ 成员：GROUP 严格用成员表（被移除即不可 @）；未定型沿用
  // agentIds ∪ 历史发言者的宽松集合
  const memberAgents = useMemo(() => {
    if (conversationMode === "group") {
      const ids = new Set(currentConversation?.agentIds ?? []);
      return agents.filter((agent) => ids.has(agent.id));
    }
    const ids = new Set(currentConversation?.agentIds ?? []);
    currentConversation?.messages.forEach((m) => {
      if (m.role === "assistant" && m.agentId) {
        ids.add(m.agentId);
      }
    });
    return agents.filter((agent) => ids.has(agent.id));
  }, [conversationMode, currentConversation, agents]);

  // 单聊绑定的智能体（标题/占位文案用）
  const boundAgent =
    conversationMode === "single"
      ? findAgent(
          agents,
          currentConversation?.defaultAgentId ??
            currentConversation?.agentIds?.[0] ??
            null,
        )
      : undefined;

  // 新对话页当前选中的智能体（粘性选择，首条消息发出时才真正绑定成会话）
  const newChatAgent = findAgent(agents, selectedAgentId);

  const navTitle =
    conversationMode === "group"
      ? `${currentConversation?.title || "群聊"} (${currentConversation?.agentIds?.length ?? 0})`
      : conversationMode === "single"
        ? boundAgent?.name || currentConversation?.title || "AI 助手"
        : // 尚未选定会话时就是新对话页，标题跟着说「新对话」而不是「AI 助手」
          currentConversation?.title || "新对话";
  const isStreaming = currentConversation?.messages.some(
    (m) => m.status === "streaming",
  );

  useEffect(() => {
    if (conversationId) {
      setCurrentConversation(conversationId);
    }
  }, [conversationId, setCurrentConversation]);

  // 换会话就清空输入框。ChatInput 的草稿与 @ 绑定是它自己的内部 state，而
  // ChatWorkspace 常驻不重挂——不清的话，打了半句话去点「发起新对话」或切会话，
  // 文字连同上一个会话的 @ 绑定会一起带过去。
  useEffect(() => {
    const prevId = lastConversationIdRef.current;
    const nextId = currentConversation?.id;
    lastConversationIdRef.current = nextId;

    // 草稿 id 被换成真实 id（task.created）不是换会话，是同一轮对话。
    // 这时清空会把用户已经在打的下一句话抹掉。
    if (prevId?.startsWith("draft_")) {
      return;
    }
    if (prevId !== nextId) {
      chatInputRef.current?.setDraft("");
    }
  }, [currentConversation?.id]);

  useDidHide(() => {
    persistConversations();
  });

  // 跨页面/重启续接：进入会话时若存在进行中任务指针，探测任务状态——
  // 可续接则从 0 游标重放帧接回流；已终态则直接取终稿刷新消息。
  useEffect(() => {
    const convId = currentConversation?.id;
    if (!convId || convId.startsWith("draft_")) {
      return;
    }
    if (activeAssistantMessageIdRef.current) {
      return;
    }
    if (resumeProbedRef.current.has(convId)) {
      return;
    }
    resumeProbedRef.current.add(convId);

    const stuckMessage = [...(currentConversation?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant" && m.status === "streaming");
    const pending = getPendingTask(convId);

    if (!pending) {
      // 无指针但消息卡在 streaming（历史遗留）：收敛为 done，避免永久转圈
      if (stuckMessage) {
        updateMessageStatus(stuckMessage.id, "done");
      }
      return;
    }

    void (async () => {
      try {
        const status = await streamTaskService.getTaskStatus(pending.taskId);
        const targetMessage =
          currentConversation?.messages.find(
            (m) => m.id === status.messageId,
          ) ?? stuckMessage;
        if (!targetMessage) {
          // 只说明本地快照里还没有这条消息（storage 未落盘、远程列表未回来），
          // 不代表后端任务不存在——清掉指针会让这轮回答再也接不回来。
          // 留着指针，下次进入会话时重新探测。
          return;
        }

        if (status.canResume) {
          // 从 0 游标全量重放帧重建内容，避免与本地半截内容重复拼接
          setMessageContent(targetMessage.id, "");
          updateMessageStatus(targetMessage.id, "streaming");
          activeAssistantMessageIdRef.current = targetMessage.id;
          resume(
            pending.taskId,
            "0",
            buildStreamLifecycle(targetMessage.id, convId),
            "streaming",
          );
          return;
        }

        // 已终态：帧缓存可能已过期，直接用任务表的终稿收敛
        if (status.fullContent) {
          setMessageContent(targetMessage.id, status.fullContent);
        }
        updateMessageStatus(
          targetMessage.id,
          status.status === "error" || status.status === "expired"
            ? "error"
            : "done",
        );
        clearPendingTask(convId);
        persistConversations();
      } catch (error) {
        console.warn("Resume probe failed:", error);
        // 只有服务端明确说这个任务没了（404/410）才收敛消息并清指针。
        // 网络不通、超时这类瞬时失败保留指针——一次抖动就把指针清掉，
        // 这轮回答会永久接不回来（与上面 targetMessage 缺失同一类误判）。
        const status =
          error instanceof ApiRequestError ? error.status : undefined;
        if (status === 404 || status === 410) {
          if (stuckMessage) {
            updateMessageStatus(stuckMessage.id, "done");
          }
          clearPendingTask(convId);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConversation]);

  useEffect(() => {
    return () => {
      // 只断开本地连接，不动消息状态：任务仍在后端执行，
      // streaming 状态是重进页面时触发续接探测的信号
      abort();
      activeAssistantMessageIdRef.current = null;
      persistConversations();
    };
  }, [abort, persistConversations]);

  /**
   * 构建流式生命周期处理器
   * @description 发送与跨页面续接共用：事件反馈卡、标题更新、审批卡、
   * 任务指针（task.created 记录 / 终态清除）与消息状态收敛。
   */
  const buildStreamLifecycle = (
    aiMsgId: string,
    localConversationId?: string,
  ): StreamTaskLifecycle => {
    let taskConversationId = localConversationId ?? "";

    const recordStreamEvent = (event: StreamTaskEvent) => {
      const feedback = toMessageStreamFeedback(event);
      if (feedback) {
        updateMessageStreamEvent(aiMsgId, feedback);
      }
    };
    const settle = (status: MessageStatus) => {
      updateMessageStatus(aiMsgId, status);
      activeAssistantMessageIdRef.current = null;
      if (taskConversationId) {
        clearPendingTask(taskConversationId);
      }
      persistConversations();
    };

    return {
      onTaskCreated: (
        { conversationId: realConversationId, taskId, agentId: answeringId },
        event,
      ) => {
        recordStreamEvent(event);
        if (localConversationId?.startsWith("draft_")) {
          replaceConversationId(localConversationId, realConversationId);
        }
        taskConversationId = realConversationId;
        // 群聊不 @ 时回答者由后端自动路由，发送时前端并不知道是谁；
        // 这里用真实回答者回填，否则气泡会一直显示占位时猜的默认助手。
        if (answeringId) {
          updateMessageSpeaker(
            aiMsgId,
            answeringId,
            resolveAgentName(useAgentStore.getState().agents, answeringId),
          );
        }
        // 跨页面续接的锚点：进行中任务指针落本地存储
        savePendingTask(realConversationId, taskId);
        // 指针和消息必须同时落盘。只存指针的话，刷新后 hydrate 出的会话里
        // 没有这条 streaming 消息，续接探测找不到目标 → 直接放弃，
        // 这轮回答就再也接不回来了（表现为一直等不到内容，再刷一次才出现）。
        persistConversations();
      },
      onStatus: recordStreamEvent,
      onToolCall: recordStreamEvent,
      // 首轮回答流式输出期间收到 AI 生成的会话标题，实时替换截断兜底标题
      onConversationTitle: (title, realConversationId) => {
        updateConversationTitle(realConversationId, title);
        persistConversations();
      },
      onApprovalRequired: (event) => {
        recordStreamEvent(event);
        setMessageApproval(
          aiMsgId,
          (event.data.payload as ApprovalRequiredPayload | undefined) ?? null,
        );
      },
      onPlanReviewRequired: (event) => {
        recordStreamEvent(event);
        setMessagePlanReview(
          aiMsgId,
          (event.data.payload as PlanReviewRequiredPayload | undefined) ?? null,
        );
      },
      onOrderCreated: ({ order }, event) => {
        recordStreamEvent(event);
        upsertMessageOrder(aiMsgId, order);
        persistConversations();
      },
      onChunk: (chunk) => {
        updateMessageContent(aiMsgId, chunk);
      },
      onCompleted: (event) => {
        if (event) {
          recordStreamEvent(event);
        }
        settle("done");
      },
      onMessageDone: (_content, event) => {
        recordStreamEvent(event);
        updateMessageMetrics(aiMsgId, event.data.payload?.metrics);
        settle("done");
      },
      onError: (error, event) => {
        console.error("Chat stream failed:", error);
        if (event) {
          recordStreamEvent(event);
        }
        // 资格可能在页面停留期间被后台调整。发送入口以后端实时判定为准；
        // 被拒绝或执行失败后立即刷新列表，让锁定状态与下一次操作同步收敛。
        void useAgentStore.getState().loadAgents();
        settle("error");
      },
      onCanceled: (event) => {
        if (event) {
          recordStreamEvent(event);
        }
        settle("done");
      },
    };
  };

  const handleSend = (
    content: string,
    agentId?: string,
    modelSelection?: AgentModelSelection,
    image?: ChatImageAttachment,
  ) => {
    const localConversationId =
      currentConversation?.id || ensureDraftConversation();
    const requestConversationId = localConversationId.startsWith("draft_")
      ? undefined
      : localConversationId;

    const userMsg: Message = {
      id: genMsgId(),
      role: "user",
      content,
      imageUrl: image?.imageUrl,
      status: "done",
      createdAt: Date.now(),
    };
    addMessage(userMsg);

    const aiMsgId = genMsgId();
    const aiMsg: Message = {
      id: aiMsgId,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: Date.now(),
      // 归属：@ 指定、或单聊/未定型会话，占位即可显示正确身份；
      // 群聊未 @ 时回答者由后端自动路由，此时留空并标记 routing，
      // 等 task.created 回填——不能用 resolveAgentName 兜底，它在 id 为空时
      // 返回「默认助手」，群聊下必然显示成错误的人。
      agentId: agentId ?? null,
      agentName:
        agentId || conversationMode !== "group"
          ? resolveAgentName(useAgentStore.getState().agents, agentId)
          : undefined,
      routing: !agentId && conversationMode === "group",
    };
    addMessage(aiMsg);
    activeAssistantMessageIdRef.current = aiMsgId;
    const selectionFingerprint = modelSelectionFingerprint(modelSelection);
    if (selectionFingerprint) {
      updateConversationModelSelection(
        localConversationId,
        selectionFingerprint,
      );
    }

    sendMessage(
      {
        conversationId: requestConversationId,
        content,
        imageAssetId: image?.imageAssetId,
        agentId,
        selectedModelPresetId: modelSelection?.modelPresetId,
        reasoning: modelSelection?.reasoning,
      },
      buildStreamLifecycle(aiMsgId, localConversationId),
    );
  };

  /**
   * 上传语音并接回现有任务流
   * @param filePath 录音产生的临时文件路径
   * @param agentId 本条语音明确选择的回答智能体；群聊自动路由时为空
   * @param modelSelection 当前 Agent 对应的本轮模型与思考选择
   * @returns 无返回值
   * @description 先插入本地占位消息，再创建语音任务；拿到 taskId 后立即保存续接指针并
   * 从 0 游标恢复 SSE。上传失败只收敛当前占位，不会重新创建任务。
   */
  const handleVoiceRecordComplete = (
    filePath: string,
    agentId?: string,
    modelSelection?: AgentModelSelection,
  ) => {
    const localConversationId =
      currentConversation?.id || ensureDraftConversation();
    const requestConversationId = localConversationId.startsWith("draft_")
      ? undefined
      : localConversationId;
    const userMsgId = genMsgId();
    addMessage({
      id: userMsgId,
      role: "user",
      content: "[语音消息]",
      status: "sending",
      createdAt: Date.now(),
    });

    const aiMsgId = genMsgId();
    addMessage({
      id: aiMsgId,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: Date.now(),
      agentId: agentId ?? null,
      agentName:
        agentId || conversationMode !== "group"
          ? resolveAgentName(useAgentStore.getState().agents, agentId)
          : undefined,
      routing: !agentId && conversationMode === "group",
    });
    activeAssistantMessageIdRef.current = aiMsgId;

    const selectionFingerprint = modelSelectionFingerprint(modelSelection);
    if (selectionFingerprint) {
      updateConversationModelSelection(
        localConversationId,
        selectionFingerprint,
      );
    }
    persistConversations();

    void streamTaskService
      .createVoiceTask({
        filePath,
        conversationId: requestConversationId,
        agentId,
        selectedModelPresetId: modelSelection?.modelPresetId,
        reasoning: modelSelection?.reasoning,
      })
      .then((task) => {
        updateMessageStatus(userMsgId, "done");
        if (localConversationId.startsWith("draft_")) {
          replaceConversationId(localConversationId, task.conversationId);
        }
        savePendingTask(task.conversationId, task.taskId);
        persistConversations();
        resume(
          task.taskId,
          "0",
          buildStreamLifecycle(aiMsgId, localConversationId),
          "streaming",
        );
      })
      .catch((error: unknown) => {
        console.error("Voice message upload failed:", error);
        updateMessageStatus(userMsgId, "error");
        updateMessageStatus(aiMsgId, "error");
        activeAssistantMessageIdRef.current = null;
        persistConversations();
      });
  };

  const handleApproval = (msgId: string, decision: ApprovalDecision) => {
    resolveMessageApproval(msgId, decision.decision);
    updateMessageStatus(msgId, "streaming");
    activeAssistantMessageIdRef.current = msgId;
    submitApproval(decision);
  };

  const handlePlanReview = (msgId: string, decision: PlanReviewDecision) => {
    setMessagePlanReview(msgId, null);
    updateMessageStatus(msgId, "streaming");
    activeAssistantMessageIdRef.current = msgId;
    submitPlanReview(decision);
  };

  const messages = currentConversation?.messages || [];
  const showEmptySlot = messages.length === 0 && renderEmpty;

  return (
    <PageShell>
      <NavBar
        title={navTitle}
        left={navLeft}
        showBack={showBack}
        capsule="hidden"
        barClassName="px-[0.5rem]"
      />

      {/* 只有群聊才显示成员条。用 !== "single" 会让单聊首轮闪现一条
          「1 位助手参与」——占位消息带了 agentId，未定型(flex)分支会把它并进
          memberAgents，直到下次 loadConversations 返回 type=SINGLE 才消失。 */}
      {conversationMode === "group" ? (
        <MemberBar
          members={memberAgents}
          onMention={(agent) => chatInputRef.current?.insertMention(agent)}
        />
      ) : null}

      <View className="flex min-h-0 flex-1 flex-col">
        {showEmptySlot ? (
          <View className="min-h-0 flex-1 overflow-y-auto">
            {renderEmpty({
              setDraft: (text) => chatInputRef.current?.setDraft(text),
            })}
          </View>
        ) : (
          <MessageList
            messages={messages}
            isStreaming={!!isStreaming}
            conversationId={currentConversation?.id}
            onToggleStreamFeedback={toggleMessageStreamFeedback}
            onApproval={handleApproval}
            onPlanReview={handlePlanReview}
          />
        )}
      </View>

      <View>
        <ChatInput
          ref={chatInputRef}
          onSend={handleSend}
          onRecordComplete={handleVoiceRecordComplete}
          reserveSafeArea
          mode={conversationMode}
          // 新对话页期间关掉 @：面板刚选了 A，再 @B 发送会把新会话绑给 B，
          // 而面板仍高亮 A——这是唯一一处「显示与实际不符」
          mentionAgents={
            showEmptySlot
              ? []
              : conversationMode === "group"
                ? memberAgents
                : undefined
          }
          modelAgentId={
            conversationMode === "single"
              ? boundAgent?.id
              : conversationMode === "flex"
                ? newChatAgent?.id
                : undefined
          }
          lastModelSelectionFingerprint={
            currentConversation?.lastModelSelectionFingerprint
          }
          placeholder={
            conversationMode === "single" && boundAgent
              ? `和${boundAgent.name}聊聊...`
              : showEmptySlot && newChatAgent
                ? `和${newChatAgent.name}聊聊...`
                : undefined
          }
          onStop={() => {
            if (activeAssistantMessageIdRef.current) {
              updateMessageStatus(activeAssistantMessageIdRef.current, "done");
              activeAssistantMessageIdRef.current = null;
              persistConversations();
            }
            void cancel().catch((error) => {
              console.error("Cancel chat stream failed:", error);
            });
          }}
          isStreaming={!!isStreaming}
        />
      </View>
    </PageShell>
  );
}
