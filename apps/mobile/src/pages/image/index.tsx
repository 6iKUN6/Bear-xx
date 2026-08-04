import { View, Text } from "@tarojs/components";
import TabPageTopInset from "../../components/TabPageTopInset";
import PageShell from "../../components/PageShell";
import {
  appGlassCardClass,
  appGlassCardStrongClass,
  appGradientSurfaceClass,
  appHeroClass,
  appHeroSubtitleClass,
  appHeroTitleClass,
  appScreenClass,
} from "../../utils/style";

const styleOptions = [
  { icon: "🎨", text: "水彩", active: true },
  { icon: "🪄", text: "赛博朋克" },
  { icon: "🖼", text: "插画" },
  { icon: "✦", text: "抽象" },
];

const ratioOptions = ["1:1", "3:4", "16:9"];

const promptIdeas = [
  "一只在月光下读书的小熊，柔和水彩风",
  "未来城市里的雨夜咖啡店，霓虹灯反射",
  "适合头像的可爱小熊机器人，干净背景",
];

export default function ImagePage() {
  return (
    <PageShell>
      <TabPageTopInset />
      <View className={appScreenClass}>
        <View className={`${appHeroClass} pt-[0.875rem]`}>
          <Text className={appHeroTitleClass}>AI 画图</Text>
          <Text className={appHeroSubtitleClass}>
            用文字描述，让 AI 为你创作
          </Text>
        </View>

        <View className='px-[1rem] pt-[0.75rem]'>
          <View
            className={`${appGlassCardStrongClass} px-[1.25rem] py-[1.25rem]`}
          >
            <Text className='block text-[1.0625rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]'>
              描述你想看的画面
            </Text>
            <View className='mt-[0.875rem] min-h-[7rem] rounded-[var(--lb-radius-md)] border border-[var(--lb-line-strong)] bg-[var(--lb-surface)] px-[1rem] py-[0.875rem] box-border'>
              <Text className='block text-[0.9375rem] leading-[1.65] text-[var(--lb-text-secondary)]'>
                例如：一只穿雨衣的小熊走在黄昏街道，手里拿着热可可，温暖电影感
              </Text>
            </View>

            <View className='mt-[1rem]'>
              <Text className='mb-[0.625rem] block text-[0.8125rem] font-semibold leading-none text-[var(--lb-text-muted)]'>
                风格
              </Text>
              <View className='grid grid-cols-4 gap-[0.5rem]'>
                {styleOptions.map((item) => (
                  <View
                    key={item.text}
                    className={`flex flex-col items-center justify-center rounded-[var(--lb-radius-md)] px-[0.5rem] py-[0.625rem] ${item.active ? appGradientSurfaceClass : "border border-[var(--lb-line-soft)] bg-[var(--lb-surface)]"}`}
                  >
                    <Text className='text-[1.125rem] leading-none'>
                      {item.icon}
                    </Text>
                    <Text
                      className={`mt-[0.375rem] text-[0.6875rem] font-medium leading-none ${item.active ? "text-[var(--lb-on-accent)]" : "text-[var(--lb-text-secondary)]"}`}
                    >
                      {item.text}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            <View className='mt-[1rem] flex items-center justify-between gap-[0.75rem]'>
              <View className='min-w-0 flex-1'>
                <Text className='mb-[0.625rem] block text-[0.8125rem] font-semibold leading-none text-[var(--lb-text-muted)]'>
                  比例
                </Text>
                <View className='flex gap-[0.5rem]'>
                  {ratioOptions.map((ratio, index) => (
                    <View
                      key={ratio}
                      className={`rounded-[var(--lb-radius-sm)] border px-[0.75rem] py-[0.375rem] ${index === 0 ? "border-[var(--lb-accent)] bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]" : "border-[var(--lb-line-soft)] bg-[var(--lb-surface)] text-[var(--lb-text-secondary)]"}`}
                    >
                      <Text className='text-[0.75rem] font-semibold leading-none'>
                        {ratio}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
              <View className='rounded-[var(--lb-radius-md)] bg-[var(--lb-surface-hover)] px-[1rem] py-[0.75rem]'>
                <Text className='block text-[0.8125rem] font-semibold leading-none text-[var(--lb-text-muted)]'>
                  即将开放
                </Text>
              </View>
            </View>
          </View>
        </View>

        <View className='px-[1rem] pt-[1.375rem]'>
          <Text className='mb-[0.875rem] block px-[0.5rem] text-[1rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]'>
            灵感模板
          </Text>
          <View className='flex flex-col gap-[0.625rem]'>
            {promptIdeas.map((idea) => (
              <View
                key={idea}
                className={`${appGlassCardClass} px-[1rem] py-[0.875rem]`}
              >
                <Text className='block text-[0.875rem] leading-[1.5] text-[var(--lb-text-primary)]'>
                  {idea}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </View>

    </PageShell>
  );
}
