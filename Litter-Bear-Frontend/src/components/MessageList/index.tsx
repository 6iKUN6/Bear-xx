import { useEffect, useRef } from "react";
import { ScrollView, View } from "@tarojs/components";
import ChatBubble from "../ChatBubble";

interface MessageListProps {
  messages: Message[];
}

export default function MessageList({ messages }: MessageListProps) {
  const scrollId = useRef("msg-bottom");
  const scrollIntoView = messages.length > 0 ? scrollId.current : "";

  const scrollKey = useRef(0);
  useEffect(() => {
    scrollKey.current++;
  }, [messages]);

  return (
    <ScrollView
      className='flex-1 overflow-hidden pt-rpx-32 box-border'
      scrollY
      scrollIntoView={scrollIntoView}
      scrollWithAnimation
      key={scrollKey.current}
    >
      {messages.map((msg) => (
        <ChatBubble key={msg.id} message={msg} />
      ))}
      <View id='msg-bottom' className='h-rpx-24' />
    </ScrollView>
  );
}
