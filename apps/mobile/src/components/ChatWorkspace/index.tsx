import { useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { View } from "@tarojs/components";
import { useDidHide } from "@tarojs/taro";
import type {
  ApprovalDecision,
  ApprovalRequiredPayload,
} from "@litter-bear/types/protocol";
import MessageList from "../MessageList";
import ChatInput from "../ChatInput";
import type { ChatInputHandle } from "../ChatInput";
import MemberBar from "../MemberBar";
import NavBar from "../NavBar";
import PageShell from "../PageShell";
import { useChatStore } from "../../store/chatStore";
import { useAgentStore } from "../../store/agentStore";
import { resolveAgentName } from "../../utils/agent";
import { useChatStream } from "../../hooks/useChatStream";
import { toMessageStreamFeedback } from "../../utils/streamFeedback";
import { streamTaskService } from "../../services/stream";
import type { StreamTaskEvent, StreamTaskLifecycle } from "../../services/stream";
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
  /** 输入栏下方是否为 TabBar 预留空间（首页 = true，独立 chat 页 = false） */
  aboveTabBar?: boolean;
  /** 无消息时渲染的占位内容（开场提示卡等） */
  renderEmpty?: (actions: ChatWorkspaceEmptySlotActions) => ReactNode;
}

/**
 * 聊天工作台（页面级共享组件）
 * @description 完整的对话交互：消息列表、群成员条、@ 提及输入栏、审批卡、
 * SSE 流式接线与标题实时更新。首页（最近对话直显 + TabBar）与独立 chat 页
 * （返回键导航）共用，两处只有导航栏与底部留白的差异。
 */
export default function ChatWorkspace({
  conversationId,
  navLeft,
  showBack = false,
  aboveTabBar = false,
  renderEmpty,
}: ChatWorkspaceProps) {
  const { abort, cancel, sendMessage, submitApproval, resume } =
    useChatStream();

  const {
    currentConversation,
    setCurrentConversation,
    ensureDraftConversation,
    replaceConversationId,
    updateConversationTitle,
    addMessage,
    updateMessageContent,
    setMessageContent,
    updateMessageMetrics,
    updateMessageStatus,
    updateMessageStreamEvent,
    toggleMessageStreamFeedback,
    setMessageApproval,
    persistConversations,
  } = useChatStore();

  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  /** 每个会话每次挂载只做一次续接探测，避免消息更新反复触发 */
  const resumeProbedRef = useRef<Set<string>>(new Set());
  const agents = useAgentStore((state) => state.agents);

  // 群成员 = 会话 agentIds ∪ 历史消息中出现过的发言者（本地即时补充，
  // 不用等服务端会话重新拉取），再映射到已加载的智能体列表
  const memberAgents = useMemo(() => {
    const ids = new Set(currentConversation?.agentIds ?? []);
    currentConversation?.messages.forEach((m) => {
      if (m.role === "assistant" && m.agentId) {
        ids.add(m.agentId);
      }
    });
    return agents.filter((agent) => ids.has(agent.id));
  }, [currentConversation, agents]);
  const isStreaming = currentConversation?.messages.some(
    (m) => m.status === "streaming",
  );

  useEffect(() => {
    if (conversationId) {
      setCurrentConversation(conversationId);
    }
  }, [conversationId, setCurrentConversation]);

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
          clearPendingTask(convId);
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
        if (stuckMessage) {
          updateMessageStatus(stuckMessage.id, "done");
        }
        clearPendingTask(convId);
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
      onTaskCreated: ({ conversationId: realConversationId, taskId }, event) => {
        recordStreamEvent(event);
        if (localConversationId?.startsWith("draft_")) {
          replaceConversationId(localConversationId, realConversationId);
        }
        taskConversationId = realConversationId;
        // 跨页面续接的锚点：进行中任务指针落本地存储
        savePendingTask(realConversationId, taskId);
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

  const handleSend = (content: string, agentId?: string) => {
    const localConversationId =
      currentConversation?.id || ensureDraftConversation();
    const requestConversationId = localConversationId.startsWith("draft_")
      ? undefined
      : localConversationId;

    const userMsg: Message = {
      id: genMsgId(),
      role: "user",
      content,
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
      // 群聊归属：占位消息即带上发言者，流式期间气泡就能显示正确头像/名字
      agentId: agentId ?? null,
      agentName: resolveAgentName(useAgentStore.getState().agents, agentId),
    };
    addMessage(aiMsg);
    activeAssistantMessageIdRef.current = aiMsgId;

    sendMessage(
      {
        conversationId: requestConversationId,
        content,
        agentId,
      },
      buildStreamLifecycle(aiMsgId, localConversationId),
    );
  };

  const handleApproval = (msgId: string, decision: ApprovalDecision) => {
    setMessageApproval(msgId, null);
    updateMessageStatus(msgId, "streaming");
    activeAssistantMessageIdRef.current = msgId;
    submitApproval(decision);
  };

  const messages = currentConversation?.messages || [];
  const showEmptySlot = messages.length === 0 && renderEmpty;

  return (
    <PageShell>
      <NavBar
        title={currentConversation?.title || "AI 助手"}
        left={navLeft}
        showBack={showBack}
        capsule='hidden'
        barClassName='px-[0.5rem]'
      />

      <MemberBar
        members={memberAgents}
        onMention={(agent) => chatInputRef.current?.insertMention(agent)}
      />

      <View className='flex min-h-0 flex-1 flex-col'>
        {showEmptySlot ? (
          <View className='min-h-0 flex-1 overflow-y-auto'>
            {renderEmpty({
              setDraft: (text) => chatInputRef.current?.setDraft(text),
            })}
          </View>
        ) : (
          <MessageList
            messages={messages}
            isStreaming={!!isStreaming}
            onToggleStreamFeedback={toggleMessageStreamFeedback}
            onApproval={handleApproval}
          />
        )}
      </View>

      <View
        className={
          aboveTabBar
            ? "pb-[calc(env(safe-area-inset-bottom)+3.25rem)]"
            : ""
        }
      >
        <ChatInput
          ref={chatInputRef}
          onSend={handleSend}
          reserveSafeArea={!aboveTabBar}
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
