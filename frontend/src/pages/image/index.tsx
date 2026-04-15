import { View, Text } from "@tarojs/components";
import TabBar from "../../components/TabBar";

const quickPrompts = [
  { icon: "🎨", text: "水彩画风格", gradient: "from-[#ff2f92] to-[#ff5178]" },
  { icon: "🪄", text: "赛博朋克", gradient: "from-[#7c3aed] to-[#5b5cf6]" },
  { icon: "🖼", text: "梦幻插画", gradient: "from-[#1d9bf0] to-[#1483ff]" },
  { icon: "✦", text: "抽象艺术", gradient: "from-[#ff8a00] to-[#ffb200]" },
];

export default function ImagePage() {
  return (
    <View className='app-page'>
      <View className='app-screen'>
        <View className='app-hero pt-[44px]'>
          <Text className='app-hero-title'>AI 画图</Text>
          <Text className='app-hero-subtitle'>用文字描述，让 AI 为你创作</Text>
        </View>

        <View className='px-[16px] pt-[12px]'>
          <View className='app-glass-card-strong px-[28px] py-[24px] text-center'>
            <View className='app-float relative mx-auto mb-[28px] h-[128px] w-[128px]'>
              <View className='app-gradient-surface flex h-[116px] w-[116px] items-center justify-center rounded-[28px] text-[54px] shadow-[0_18px_42px_rgba(236,72,153,0.3)]'>
                <Text className='leading-none'>✧</Text>
              </View>
              <View className='app-gradient-surface-warm absolute bottom-[6px] right-[0px] flex h-[40px] w-[40px] items-center justify-center rounded-full text-[18px] shadow-[0_10px_22px_rgba(251,146,60,0.3)]'>
                <Text className='leading-none'>⋮</Text>
              </View>
            </View>

            <Text className='mb-[10px] block text-[22px] font-bold leading-[1.2] text-[var(--lb-text-primary)]'>
              AI 绘画工作室
            </Text>
            <Text className='block text-[15px] leading-[1.7] text-[var(--lb-text-secondary)]'>
              功能正在全力开发中
            </Text>
            <Text className='mb-[24px] block text-[15px] leading-[1.7] text-[var(--lb-text-secondary)]'>
              即将为你带来惊艳的 AI 绘画体验
            </Text>

            <View className='mb-[8px] mx-[8px] h-[6px] overflow-hidden rounded-full bg-[#f1f1f7]'>
              <View className='h-full rounded-full bg-gradient-to-r from-[#9333ea] via-[#ec4899] to-[#6366f1]' style={{ width: "75%" }} />
            </View>
            <Text className='text-[13px] leading-none text-[var(--lb-text-muted)]'>
              开发进度 75%
            </Text>
          </View>
        </View>

        <View className='px-[16px] pt-[22px]'>
          <Text className='mb-[14px] block px-[8px] text-[16px] font-semibold leading-[1.3] text-[var(--lb-text-primary)]'>
            即将支持的风格
          </Text>
          <View className='grid grid-cols-2 gap-[12px]'>
            {quickPrompts.map((prompt) => (
              <View key={prompt.text} className='app-glass-card px-[18px] py-[18px]'>
                <View className={`mb-[12px] flex h-[42px] w-[42px] items-center justify-center rounded-[14px] bg-gradient-to-br ${prompt.gradient} text-[18px] text-white shadow-[0_10px_20px_rgba(124,58,237,0.16)]`}>
                  <Text className='leading-none'>{prompt.icon}</Text>
                </View>
                <Text className='block text-[15px] font-medium leading-[1.4] text-[var(--lb-text-primary)]'>
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
