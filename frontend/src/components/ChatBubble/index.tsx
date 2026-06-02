import { View, Text } from "@tarojs/components";

interface ChatBubbleProps {
  message: Message;
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

export default function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === "user";

  return (
    <View
      className={`mb-[1.5rem] flex px-[1rem] ${isUser ? "justify-end" : "justify-start"}`}
    >
      <View className={`max-w-[82%] ${isUser ? "items-end" : "items-start"}`}>
        {!isUser && (
          <View className='app-icon-tile mb-[0.5rem] h-[2.375rem] w-[2.375rem] rounded-[0.75rem] text-[1.125rem] shadow-[0_0.75rem_1.5rem_rgba(236,72,153,0.22)]'>
            <Text className='leading-none'>🐻</Text>
          </View>
        )}

        <View
          className={`box-border px-[1.125rem] py-[0.875rem] text-[1rem] leading-[1.7] shadow-[0_0.625rem_1.5rem_rgba(124,58,237,0.06)] ${isUser ? "rounded-[1.125rem_1.125rem_0.375rem_1.125rem] bg-gradient-to-r from-[#9333ea] via-[#ec4899] to-[#6366f1] text-white" : "rounded-[1.125rem_1.125rem_1.125rem_0.375rem] border border-[rgba(196,181,253,0.2)] bg-white text-[var(--lb-text-primary)]"}`}
        >
          <Text className='whitespace-pre-wrap'>{message.content}</Text>
          {message.status === "streaming" && (
            <Text className='ml-[0.25rem] text-white/90'>▍</Text>
          )}
        </View>

        <Text
          className={`mt-[0.5rem] px-[0.375rem] text-[0.75rem] leading-none text-[var(--lb-text-muted)] ${isUser ? "text-right" : "text-left"}`}
        >
          {formatTime(message.createdAt)}
        </Text>

        {message.status === "error" && (
          <Text className='mt-[0.375rem] block px-[0.375rem] text-[0.75rem] text-[var(--lb-danger)]'>
            发送失败
          </Text>
        )}
      </View>
    </View>
  );
}
