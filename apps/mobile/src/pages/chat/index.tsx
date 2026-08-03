import { useEffect, useRef } from "react";
import { View } from "@tarojs/components";
import { useRouter, useDidHide } from "@tarojs/taro";
import type {
  ApprovalDecision,
  ApprovalRequiredPayload,
} from "@litter-bear/types/protocol";
import MessageList from "../../components/MessageList";
import ChatInput from "../../components/ChatInput";
import NavBar from "../../components/NavBar";
import PageShell from "../../components/PageShell";
import AgentSwitcher from "../../components/AgentSwitcher";
import { useChatStore } from "../../store/chatStore";
import { useAgentStore } from "../../store/agentStore";
import { useChatStream } from "../../hooks/useChatStream";
import { toMessageStreamFeedback } from "../../utils/streamFeedback";
import type { StreamTaskEvent } from "../../services/stream";

let idCounter = Date.now();
function genMsgId(): string {
  return "msg_" + ++idCounter;
}

export default function ChatPage() {
  const router = useRouter();
  const conversationId = router.params.conversationId || "";
  const { abort, cancel, sendMessage, submitApproval } = useChatStream();

  const {
    currentConversation,
    setCurrentConversation,
    ensureDraftConversation,
    replaceConversationId,
    updateConversationTitle,
    addMessage,
    updateMessageContent,
    updateMessageMetrics,
    updateMessageStatus,
    updateMessageStreamEvent,
    toggleMessageStreamFeedback,
    setMessageApproval,
    persistConversations,
  } = useChatStore();

  const activeAssistantMessageIdRef = useRef<string | null>(null);
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

  useEffect(() => {
    return () => {
      abort();
      if (activeAssistantMessageIdRef.current) {
        updateMessageStatus(activeAssistantMessageIdRef.current, "done");
        activeAssistantMessageIdRef.current = null;
      }
      persistConversations();
    };
  }, [abort, persistConversations, updateMessageStatus]);

  const handleSend = (content: string) => {
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
    };
    addMessage(aiMsg);
    activeAssistantMessageIdRef.current = aiMsgId;

    const recordStreamEvent = (event: StreamTaskEvent) => {
      const feedback = toMessageStreamFeedback(event);
      if (feedback) {
        updateMessageStreamEvent(aiMsgId, feedback);
      }
    };

    sendMessage(
      {
        conversationId: requestConversationId,
        content,
        agentId: useAgentStore.getState().selectedAgentId ?? undefined,
      },
      {
        onTaskCreated: ({ conversationId: realConversationId }, event) => {
          recordStreamEvent(event);
          if (localConversationId.startsWith("draft_")) {
            replaceConversationId(localConversationId, realConversationId);
          }
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
          updateMessageStatus(aiMsgId, "done");
          activeAssistantMessageIdRef.current = null;
          persistConversations();
        },
        onMessageDone: (_content, event) => {
          recordStreamEvent(event);
          updateMessageMetrics(aiMsgId, event.data.payload?.metrics);
          updateMessageStatus(aiMsgId, "done");
          activeAssistantMessageIdRef.current = null;
          persistConversations();
        },
        onError: (error, event) => {
          console.error("Chat stream failed:", error);
          if (event) {
            recordStreamEvent(event);
          }
          updateMessageStatus(aiMsgId, "error");
          activeAssistantMessageIdRef.current = null;
          persistConversations();
        },
        onCanceled: (event) => {
          if (event) {
            recordStreamEvent(event);
          }
          updateMessageStatus(aiMsgId, "done");
          activeAssistantMessageIdRef.current = null;
          persistConversations();
        },
      },
    );
  };

  const handleApproval = (msgId: string, decision: ApprovalDecision) => {
    setMessageApproval(msgId, null);
    updateMessageStatus(msgId, "streaming");
    activeAssistantMessageIdRef.current = msgId;
    submitApproval(decision);
  };

  const messages = currentConversation?.messages || [];
  return (
    <PageShell>
      <NavBar
        title={<AgentSwitcher />}
        showBack
        capsule="hidden"
        barClassName="px-[0.5rem]"
      />

      <View className="flex min-h-0 flex-1 flex-col">
        <MessageList
          messages={messages}
          isStreaming={!!isStreaming}
          onToggleStreamFeedback={toggleMessageStreamFeedback}
          onApproval={handleApproval}
        />
      </View>

      <ChatInput
        onSend={handleSend}
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
    </PageShell>
  );
}
