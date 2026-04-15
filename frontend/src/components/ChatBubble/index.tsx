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
      className={`mb-[24px] flex px-[16px] ${isUser ? "justify-end" : "justify-start"}`}
    >
      <View className={`max-w-[82%] ${isUser ? "items-end" : "items-start"}`}>
        {!isUser && (
          <View className='app-icon-tile mb-[8px] h-[38px] w-[38px] rounded-[12px] text-[18px] shadow-[0_12px_24px_rgba(236,72,153,0.22)]'>
            <Text className='leading-none'>🐻</Text>
          </View>
        )}

        <View
          className={`box-border px-[18px] py-[14px] text-[16px] leading-[1.7] shadow-[0_10px_24px_rgba(124,58,237,0.06)] ${isUser ? "rounded-[18px_18px_6px_18px] bg-gradient-to-r from-[#9333ea] via-[#ec4899] to-[#6366f1] text-white" : "rounded-[18px_18px_18px_6px] border border-[rgba(196,181,253,0.2)] bg-white text-[var(--lb-text-primary)]"}`}
        >
          <Text className='whitespace-pre-wrap'>{message.content}</Text>
          {message.status === "streaming" && (
            <Text className='ml-[4px] text-white/90'>▍</Text>
          )}
        </View>

        <Text
          className={`mt-[8px] px-[6px] text-[12px] leading-none text-[var(--lb-text-muted)] ${isUser ? "text-right" : "text-left"}`}
        >
          {formatTime(message.createdAt)}
        </Text>

        {message.status === "error" && (
          <Text className='mt-[6px] block px-[6px] text-[12px] text-[var(--lb-danger)]'>
            发送失败
          </Text>
        )}
      </View>
    </View>
  );
}
