import { useEffect, useRef } from "react";
import { View } from "@tarojs/components";
import { useRouter, useDidHide } from "@tarojs/taro";
import MessageList from "../../components/MessageList";
import ChatInput from "../../components/ChatInput";
import { useChatStore } from "../../store/chatStore";
import { sendMessage } from "../../api/chat";

let idCounter = Date.now();
function genMsgId(): string {
  return "msg_" + ++idCounter;
}

export default function ChatPage() {
  const router = useRouter();
  const conversationId = router.params.conversationId || "";

  const {
    currentConversation,
    setCurrentConversation,
    addMessage,
    updateMessageContent,
    updateMessageStatus,
    persistConversations,
  } = useChatStore();

  const abortRef = useRef<{ abort: () => void } | null>(null);
  const isStreaming = currentConversation?.messages.some(
    (m) => m.status === "streaming"
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
      abortRef.current?.abort();
      persistConversations();
    };
  }, [persistConversations]);

  const handleSend = (content: string) => {
    if (!currentConversation) return;

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

    const task = sendMessage(
      currentConversation.id,
      content,
      (chunk) => {
        updateMessageContent(aiMsgId, chunk);
      },
      () => {
        updateMessageStatus(aiMsgId, "done");
        abortRef.current = null;
      },
      (_err) => {
        updateMessageStatus(aiMsgId, "error");
        abortRef.current = null;
      }
    );

    abortRef.current = task;
  };

  const messages = currentConversation?.messages || [];

  return (
    <View className='flex flex-col h-screen bg-td-bg-page'>
      <View className='flex-1 overflow-hidden'>
        <MessageList messages={messages} />
      </View>
      <View className='flex-shrink-0'>
        <ChatInput
          onSend={handleSend}
          onStop={() => abortRef.current?.abort()}
          isStreaming={!!isStreaming}
        />
      </View>
    </View>
  );
}
