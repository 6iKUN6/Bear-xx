import { useEffect, useRef } from "react";
import { View } from "@tarojs/components";
import { useRouter, useDidHide } from "@tarojs/taro";
import MessageList from "../../components/MessageList";
import ChatInput from "../../components/ChatInput";
import NavBar from "../../components/NavBar";
import { useChatStore } from "../../store/chatStore";
import { useChatStream } from "../../hooks/useChatStream";
import { appPageClass, appSolidNavClass } from "../../utils/style";
import { toMessageStreamFeedback } from "../../utils/streamFeedback";
import type { StreamTaskEvent } from "../../services/stream";

let idCounter = Date.now();
function genMsgId(): string {
  return "msg_" + ++idCounter;
}

export default function ChatPage() {
  const router = useRouter();
  const conversationId = router.params.conversationId || "";
  const { abort, cancel, sendMessage } = useChatStream();

  const {
    currentConversation,
    setCurrentConversation,
    ensureDraftConversation,
    replaceConversationId,
    addMessage,
    updateMessageContent,
    updateMessageMetrics,
    updateMessageStatus,
    updateMessageStreamEvent,
    toggleMessageStreamFeedback,
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
      { conversationId: requestConversationId, content },
      {
        onTaskCreated: ({ conversationId: realConversationId }, event) => {
          recordStreamEvent(event);
          if (localConversationId.startsWith("draft_")) {
            replaceConversationId(localConversationId, realConversationId);
          }
        },
        onStatus: recordStreamEvent,
        onToolCall: recordStreamEvent,
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

  const messages = currentConversation?.messages || [];
  return (
    <View className={appPageClass}>
      <NavBar
        title="AI 助手"
        showBack
        capsule="hidden"
        className={appSolidNavClass}
        barClassName="px-[0.5rem]"
      />

      <View className="flex min-h-0 flex-1 flex-col">
        <MessageList
          messages={messages}
          isStreaming={!!isStreaming}
          onToggleStreamFeedback={toggleMessageStreamFeedback}
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
    </View>
  );
}
