import { View, Text } from "@tarojs/components";
import TabBar from "../../components/TabBar";
import TabPageTopInset from "../../components/TabPageTopInset";

const quickPrompts = [
  { icon: "🎨", text: "水彩画风格", gradient: "from-[#ff2f92] to-[#ff5178]" },
  { icon: "🪄", text: "赛博朋克", gradient: "from-[#7c3aed] to-[#5b5cf6]" },
  { icon: "🖼", text: "梦幻插画", gradient: "from-[#1d9bf0] to-[#1483ff]" },
  { icon: "✦", text: "抽象艺术", gradient: "from-[#ff8a00] to-[#ffb200]" },
];

export default function ImagePage() {
  return (
    <View className='app-page'>
      <TabPageTopInset />
      <View className='app-screen'>
        <View className='app-hero pt-[0.875rem]'>
          <Text className='app-hero-title'>AI 画图</Text>
          <Text className='app-hero-subtitle'>用文字描述，让 AI 为你创作</Text>
        </View>

        <View className='px-[1rem] pt-[0.75rem]'>
          <View className='app-glass-card-strong px-[1.75rem] py-[1.5rem] text-center'>
            <View className='app-float relative mx-auto mb-[1.75rem] h-[8rem] w-[8rem]'>
              <View className='app-gradient-surface flex h-[7.25rem] w-[7.25rem] items-center justify-center rounded-[1.75rem] text-[3.375rem] shadow-[0_1.125rem_2.625rem_rgba(236,72,153,0.3)]'>
                <Text className='leading-none'>✧</Text>
              </View>
              <View className='app-gradient-surface-warm absolute bottom-[0.375rem] right-[0rem] flex h-[2.5rem] w-[2.5rem] items-center justify-center rounded-full text-[1.125rem] shadow-[0_0.625rem_1.375rem_rgba(251,146,60,0.3)]'>
                <Text className='leading-none'>⋮</Text>
              </View>
            </View>

            <Text className='mb-[0.625rem] block text-[1.375rem] font-bold leading-[1.2] text-[var(--lb-text-primary)]'>
              AI 绘画工作室
            </Text>
            <Text className='block text-[0.9375rem] leading-[1.7] text-[var(--lb-text-secondary)]'>
              功能正在全力开发中
            </Text>
            <Text className='mb-[1.5rem] block text-[0.9375rem] leading-[1.7] text-[var(--lb-text-secondary)]'>
              即将为你带来惊艳的 AI 绘画体验
            </Text>

            <View className='mb-[0.5rem] mx-[0.5rem] h-[0.375rem] overflow-hidden rounded-full bg-[#f1f1f7]'>
              <View className='h-full rounded-full bg-gradient-to-r from-[#9333ea] via-[#ec4899] to-[#6366f1]' style={{ width: "75%" }} />
            </View>
            <Text className='text-[0.8125rem] leading-none text-[var(--lb-text-muted)]'>
              开发进度 75%
            </Text>
          </View>
        </View>

        <View className='px-[1rem] pt-[1.375rem]'>
          <Text className='mb-[0.875rem] block px-[0.5rem] text-[1rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]'>
            即将支持的风格
          </Text>
          <View className='grid grid-cols-2 gap-[0.75rem]'>
            {quickPrompts.map((prompt) => (
              <View key={prompt.text} className='app-glass-card px-[1.125rem] py-[1.125rem]'>
                <View className={`mb-[0.75rem] flex h-[2.625rem] w-[2.625rem] items-center justify-center rounded-[0.875rem] bg-gradient-to-br ${prompt.gradient} text-[1.125rem] text-white shadow-[0_0.625rem_1.25rem_rgba(124,58,237,0.16)]`}>
                  <Text className='leading-none'>{prompt.icon}</Text>
                </View>
                <Text className='block text-[0.9375rem] font-medium leading-[1.4] text-[var(--lb-text-primary)]'>
                  {prompt.text}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </View>

      <TabBar current={1} />
    </View>
  );
}
