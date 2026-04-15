import { useEffect, useRef } from "react";
import { View } from "@tarojs/components";
import { useRouter, useDidHide } from "@tarojs/taro";
import MessageList from "../../components/MessageList";
import ChatInput from "../../components/ChatInput";
import NavBar from "../../components/NavBar";
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
        persistConversations();
      },
      () => {
        updateMessageStatus(aiMsgId, "error");
        abortRef.current = null;
        persistConversations();
      }
    );

    abortRef.current = task;
  };

  const messages = currentConversation?.messages || [];
  return (
    <View className='app-page'>
      <NavBar
        title='AI 助手'
        showBack
        capsule='hidden'
        className='app-solid-nav'
        barClassName='px-[8px]'
      />

      <View className='flex min-h-0 flex-1 flex-col'>
        <MessageList messages={messages} />
      </View>

      {isStreaming && (
        <View className='pointer-events-none px-[16px] pb-[8px]'>
          <View className='inline-flex items-center gap-[8px] rounded-full bg-white/80 px-[14px] py-[8px] shadow-[0_10px_24px_rgba(124,58,237,0.08)] backdrop-blur-[18px]'>
            <View className='app-loading-dot bg-gradient-to-r from-[#7c3aed] to-[#ec4899]' />
            <View className='app-loading-dot bg-gradient-to-r from-[#ec4899] to-[#4f46e5]' />
            <View className='app-loading-dot bg-gradient-to-r from-[#4f46e5] to-[#7c3aed]' />
          </View>
        </View>
      )}

      <ChatInput
        onSend={handleSend}
        onStop={() => abortRef.current?.abort()}
        isStreaming={!!isStreaming}
      />
    </View>
  );
}
