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
    <View
      className="fixed bottom-0 left-0 right-0 z-50 mx-auto  flex items-center justify-center border-t border-[rgba(17,24,39,0.04)] bg-white px-[8px] pt-[6px] shadow-[0_-8px_24px_rgba(124,58,237,0.05)]"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 6px)" }}
    >
      <View className="flex items-center justify-around">
        {tabs.map((tab, index) => {
          const isActive = index === current;
          return (
            <View
              key={tab.title}
              className="flex flex-1 flex-col items-center justify-center py-[4px]"
              onClick={() => handleClick(index)}
            >
              <View
                className={`flex h-[42px] w-[42px] items-center justify-center rounded-[14px] transition-all ${isActive ? "app-gradient-surface shadow-[0_10px_24px_rgba(236,72,153,0.28)]" : "bg-transparent text-[var(--lb-text-muted)]"}`}
              >
                <Text
                  className={`at-icon ${tab.icon} text-[22px] leading-none [&::before]:block ${isActive ? "text-white" : "text-[#9ca3af]"}`}
                />
              </View>
              <Text
                className={`mt-[5px] text-[10px] leading-none ${isActive ? "font-semibold text-[#ec4899]" : "font-medium text-[#9ca3af]"}`}
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
