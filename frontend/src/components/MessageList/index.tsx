import { useEffect, useRef } from "react";
import { ScrollView, View, Text } from "@tarojs/components";
import ChatBubble from "../ChatBubble";

interface MessageListProps {
  messages: Message[];
}

export default function MessageList({ messages }: MessageListProps) {
  const scrollId = useRef("msg-bottom");
  const scrollIntoView = messages.length > 0 ? scrollId.current : "";
  const scrollKey = useRef(0);

  useEffect(() => {
    scrollKey.current += 1;
  }, [messages]);

  return (
    <ScrollView
      className='flex-1 overflow-hidden px-[0px] pb-[20px] pt-[18px] box-border'
      scrollY
      scrollIntoView={scrollIntoView}
      scrollWithAnimation
      key={scrollKey.current}
    >
      {messages.length === 0 ? (
        <View className='flex min-h-full flex-col items-center justify-center px-[24px] pt-[72px] text-center box-border'>
          <View className='app-float relative mb-[28px]'>
            <View className='app-icon-tile h-[96px] w-[96px] rounded-[28px] text-[56px] shadow-[0_20px_50px_rgba(124,58,237,0.28)]'>
              <Text className='leading-none'>🐻</Text>
            </View>
            <View className='app-gradient-surface-warm app-twinkle absolute -right-[6px] -top-[6px] flex h-[38px] w-[38px] items-center justify-center rounded-full text-[18px] shadow-[0_10px_24px_rgba(251,146,60,0.3)]'>
              <Text className='leading-none'>✦</Text>
            </View>
          </View>
          <Text className='app-gradient-text mb-[10px] block text-[24px] font-bold leading-[1.2]'>
            嗨，我是 Litter Bear
          </Text>
          <Text className='block text-[16px] leading-[1.7] text-[var(--lb-text-secondary)]'>
            你的 AI 智能助手
          </Text>
          <Text className='mt-[2px] block text-[16px] leading-[1.7] text-[var(--lb-text-secondary)]'>
            有什么可以帮到你的吗？
          </Text>
        </View>
      ) : (
        <>
          {messages.map((msg) => (
            <ChatBubble key={msg.id} message={msg} />
          ))}
        </>
      )}
      <View id='msg-bottom' className='h-[20px]' />
    </ScrollView>
  );
}
