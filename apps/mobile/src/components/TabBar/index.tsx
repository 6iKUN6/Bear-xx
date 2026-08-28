import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { appShellFixedClass } from "../../utils/style";

/**
 * @deprecated 底部 TabBar 已从界面上移除，**当前没有任何页面在用它**。
 *
 * 页面间跳转改由各页自己的入口承担（如首页的「智能体」入口用 `Taro.navigateTo`）。
 * 保留数个版本再删，只为留回滚余地；不要在这里加新 tab。
 *
 * 删除时注意：`ChatInput` 的 `bottomSafeArea` 注释里还提到「上方另有 TabBar 占位」，
 * 那句话也要一并更新，否则会留下一个指向不存在组件的说明。
 */
interface TabBarProps {
  current: number;
}

const tabs = [
  { title: "聊天", icon: "at-icon-message" },
  { title: "智能体", icon: "at-icon-lightning-bolt" },
  { title: "我的", icon: "at-icon-user" },
];

const tabPages = [
  "/pages/index/index",
  "/pages/agents/index",
  "/pages/profile/index",
];

export default function TabBar({ current }: TabBarProps) {
  const handleClick = (index: number) => {
    if (index === current) return;
    Taro.redirectTo({ url: tabPages[index] });
  };

  return (
    <View
      className={`${appShellFixedClass} bottom-0 z-50 border-t border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[0.5rem] pb-[calc(env(safe-area-inset-bottom)+0.25rem)] pt-[0.25rem]`}
    >
      <View className='flex w-full flex-row items-center justify-around'>
        {tabs.map((tab, index) => {
          const isActive = index === current;
          return (
            <View
              key={tab.title}
              className='flex flex-1 flex-col items-center justify-center py-[0.25rem]'
              onClick={() => handleClick(index)}
            >
              <View
                className={`flex h-[2.5rem] w-[2.5rem] items-center justify-center rounded-[var(--lb-radius-sm)] transition-colors ${isActive ? "bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]" : "bg-transparent text-[var(--lb-text-muted)]"}`}
              >
                <Text
                  className={`at-icon ${tab.icon} text-[1.25rem] leading-none [&::before]:block ${isActive ? "text-[var(--lb-accent-ink)]" : "text-[var(--lb-text-muted)]"}`}
                />
              </View>
              <Text
                className={`mt-[0.1875rem] text-[0.625rem] leading-none ${isActive ? "font-semibold text-[var(--lb-accent-ink)]" : "font-medium text-[var(--lb-text-muted)]"}`}
              >
                {tab.title}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
