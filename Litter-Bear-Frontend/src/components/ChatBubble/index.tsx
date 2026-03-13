import { View, Text } from "@tarojs/components";

interface ChatBubbleProps {
  message: Message;
}

export default function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === "user";

  return (
    <View
      className={`flex mb-3 px-4 animate-fade-in ${
        isUser ? "justify-end" : "justify-start"
      }`}
    >
      <View
        className={`max-w-[82%] py-[20rpx] px-4 leading-relaxed break-words shadow-td-sm ${
          isUser
            ? "bg-td-brand text-white rounded-td-lg rounded-tr-[8rpx]"
            : "bg-white text-td-text-primary border border-td-border-base rounded-td-lg rounded-tl-[8rpx]"
        }`}
      >
        <Text className='text-[28rpx] whitespace-pre-wrap'>{message.content}</Text>
        {message.status === "streaming" && (
          <Text className='animate-blink text-td-text-tertiary'>▍</Text>
        )}
        {message.status === "error" && (
          <Text className='text-[24rpx] text-td-danger mt-1 block'>发送失败</Text>
        )}
      </View>
    </View>
  );
}
