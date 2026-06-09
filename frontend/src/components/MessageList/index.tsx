import { useEffect, useRef } from "react";
import { ScrollView, View, Text } from "@tarojs/components";
import ChatBubble from "../ChatBubble";
import {
  appGradientSurfaceWarmClass,
  appGradientTextClass,
  appIconTileClass,
} from "../../utils/style";

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
      className='flex-1 overflow-hidden px-[0rem] pb-[1.25rem] pt-[1.125rem] box-border'
      scrollY
      scrollIntoView={scrollIntoView}
      scrollWithAnimation
      key={scrollKey.current}
    >
      {messages.length === 0 ? (
        <View className='flex min-h-full flex-col items-center justify-center px-[1.5rem] pt-[4.5rem] text-center box-border'>
          <View className='relative mb-[1.75rem] animate-app-float'>
            <View className={`${appIconTileClass} h-[6rem] w-[6rem] rounded-[1.75rem] text-[3.5rem] shadow-[0_1.25rem_3.125rem_rgba(124,58,237,0.28)]`}>
              <Text className='leading-none'>🐻</Text>
            </View>
            <View className={`${appGradientSurfaceWarmClass} absolute -right-[0.375rem] -top-[0.375rem] flex h-[2.375rem] w-[2.375rem] animate-app-twinkle items-center justify-center rounded-full text-[1.125rem] shadow-[0_0.625rem_1.5rem_rgba(251,146,60,0.3)]`}>
              <Text className='leading-none'>✦</Text>
            </View>
          </View>
          <Text className={`${appGradientTextClass} mb-[0.625rem] block text-[1.5rem] font-bold leading-[1.2]`}>
            嗨，我是 Litter Bear
          </Text>
          <Text className='block text-[1rem] leading-[1.7] text-[var(--lb-text-secondary)]'>
            你的 AI 智能助手
          </Text>
          <Text className='mt-[0.125rem] block text-[1rem] leading-[1.7] text-[var(--lb-text-secondary)]'>
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
      <View id='msg-bottom' className='h-[1.25rem]' />
    </ScrollView>
  );
}
