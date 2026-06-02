import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";

interface TabBarProps {
  current: number;
}

const tabs = [
  { title: "聊天", icon: "at-icon-message" },
  { title: "画图", icon: "at-icon-image" },
  { title: "我的", icon: "at-icon-user" },
];

const tabPages = [
  "/pages/index/index",
  "/pages/image/index",
  "/pages/profile/index",
];

export default function TabBar({ current }: TabBarProps) {
  const handleClick = (index: number) => {
    if (index === current) return;
    Taro.redirectTo({ url: tabPages[index] });
  };

  return (
    <View className="app-shell-fixed app-tabbar">
      <View className="app-tabbar__inner">
        {tabs.map((tab, index) => {
          const isActive = index === current;
          return (
            <View
              key={tab.title}
              className="flex flex-1 flex-col items-center justify-center py-[0.25rem]"
              onClick={() => handleClick(index)}
            >
              <View
                className={`flex h-[2.625rem] w-[2.625rem] items-center justify-center rounded-[0.875rem] transition-all ${isActive ? "app-gradient-surface shadow-[0_0.625rem_1.5rem_rgba(236,72,153,0.28)]" : "bg-transparent text-[var(--lb-text-muted)]"}`}
              >
                <Text
                  className={`at-icon ${tab.icon} text-[1.375rem] leading-none [&::before]:block ${isActive ? "text-white" : "text-[#9ca3af]"}`}
                />
              </View>
              <Text
                className={`mt-[0.3125rem] text-[0.625rem] leading-none ${isActive ? "font-semibold text-[#ec4899]" : "font-medium text-[#9ca3af]"}`}
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
