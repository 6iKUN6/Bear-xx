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
      className='fixed inset-x-0 bottom-0 z-50 box-border border-t border-[rgba(220,220,220,0.92)] bg-[rgba(255,255,255,0.96)] shadow-[0_-6rpx_20rpx_rgba(17,24,39,0.06)]'
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <View className='flex min-h-rpx-112 items-stretch justify-between'>
        {tabs.map((tab, index) => {
          const isActive = index === current;
          return (
            <View
              key={tab.title}
              className={`relative flex min-w-0 flex-1 flex-col items-center justify-center gap-rpx-8 px-0 pb-rpx-16 pt-rpx-12 box-border text-center whitespace-nowrap [writing-mode:horizontal-tb] ${isActive ? "text-td-brand before:absolute before:left-1/2 before:top-0 before:h-rpx-6 before:w-rpx-56 before:-translate-x-1/2 before:rounded-td-pill-rpx before:bg-td-brand before:content-['']" : "text-td-text-tertiary"}`}
              onClick={() => handleClick(index)}
            >
              <Text className={`at-icon ${tab.icon} inline-flex h-rpx-44 w-rpx-44 items-center justify-center text-rpx-44 leading-none [&::before]:block`} />
              <Text className='block text-[22rpx] font-medium leading-[1.1]'>{tab.title}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
