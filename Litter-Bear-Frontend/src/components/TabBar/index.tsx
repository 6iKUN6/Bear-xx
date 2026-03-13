import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";

interface TabBarProps {
  current: number; // 0=聊天, 1=画图, 2=我的
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
      className='fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-td-border-base shadow-td-sm'
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <View className='flex h-[108rpx]'>
        {tabs.map((tab, index) => {
          const isActive = index === current;
          return (
            <View
              key={tab.title}
              className='flex-1 flex flex-col items-center justify-center'
              onClick={() => handleClick(index)}
            >
              <Text
                className={`at-icon ${tab.icon} text-[44rpx] leading-none mb-[6rpx] ${
                  isActive ? "text-td-brand" : "text-td-text-tertiary"
                }`}
              />
              <Text
                className={`text-[22rpx] leading-none ${
                  isActive ? "text-td-brand font-medium" : "text-td-text-tertiary"
                }`}
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
