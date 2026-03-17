import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import "./index.scss";

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
      className='app-tabbar'
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <View className='app-tabbar__inner'>
        {tabs.map((tab, index) => {
          const isActive = index === current;
          return (
            <View
              key={tab.title}
              className={`app-tabbar__item ${isActive ? "app-tabbar__item--active" : ""}`}
              onClick={() => handleClick(index)}
            >
              <Text className={`app-tabbar__icon at-icon ${tab.icon}`} />
              <Text className='app-tabbar__label'>{tab.title}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
