import { View, Text } from "@tarojs/components";
import "./index.scss";

interface ChatBubbleProps {
  message: Message;
}

export default function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === "user";

  return (
    <View
      className={`chat-bubble app-animate-fade-in ${isUser ? "chat-bubble--user" : "chat-bubble--assistant"}`}
    >
      <View
        className={`chat-bubble__inner ${isUser ? "chat-bubble__inner--user" : "chat-bubble__inner--assistant"}`}
      >
        <Text className='chat-bubble__text'>{message.content}</Text>
        {message.status === "streaming" && (
          <Text className='chat-bubble__cursor'>▍</Text>
        )}
        {message.status === "error" && (
          <Text className='chat-bubble__status'>发送失败</Text>
        )}
      </View>
    </View>
  );
}
