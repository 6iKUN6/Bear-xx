import { View, Text } from "@tarojs/components";

interface ChatBubbleProps {
  message: Message;
}

export default function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === "user";

  return (
    <View
      className={`app-animate-fade-in mb-rpx-24 flex px-rpx-32 ${isUser ? "justify-end" : "justify-start"}`}
    >
      <View
        className={`max-w-[82%] box-border px-rpx-32 py-rpx-20 shadow-td-sm ${isUser ? "rounded-[20rpx_4rpx_20rpx_20rpx] bg-td-brand text-white" : "rounded-[4rpx_20rpx_20rpx_20rpx] border border-td-border-base bg-white text-td-text-primary"}`}
      >
        <Text className='whitespace-pre-wrap text-rpx-28 leading-[1.6]'>{message.content}</Text>
        {message.status === "streaming" && (
          <Text className='ml-rpx-4 animate-blink text-td-text-tertiary'>▍</Text>
        )}
        {message.status === "error" && (
          <Text className='mt-rpx-8 block text-rpx-24 text-td-danger'>发送失败</Text>
        )}
      </View>
    </View>
  );
}
