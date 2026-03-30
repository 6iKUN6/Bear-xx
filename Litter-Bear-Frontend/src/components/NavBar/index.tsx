import type { ReactNode } from "react";
import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useNavBarMetrics } from "../../hooks/useNavBarMetrics";

interface NavBarProps {
  title?: string;
  left?: ReactNode;
  right?: ReactNode;
  showBack?: boolean;
  onBack?: () => void;
  className?: string;
  barClassName?: string;
  titleClassName?: string;
  sideWidth?: number;
}

export default function NavBar({
  title,
  left,
  right,
  showBack = true,
  onBack,
  className = "",
  barClassName = "",
  titleClassName = "",
  sideWidth,
}: NavBarProps) {
  const metrics = useNavBarMetrics();
  const resolvedSideWidth = sideWidth ?? metrics.sideWidth;

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }

    const pages = Taro.getCurrentPages();
    if (pages.length > 1) {
      Taro.navigateBack();
      return;
    }

    Taro.switchTab({ url: "/pages/index/index" }).catch(() => {
      Taro.redirectTo({ url: "/pages/index/index" });
    });
  };

  const leftContent =
    left !== undefined ? (
      left
    ) : showBack ? (
      <View
        className='flex h-10 w-10 items-center justify-center rounded-[14px]'
        onClick={handleBack}
      >
        <Text className='at-icon at-icon-chevron-left text-lg leading-none text-gray-700 [&::before]:block' />
      </View>
    ) : null;

  const rightContent = right !== undefined ? right : null;

  return (
    <View
      className={`relative z-[10] px-4 pb-2 ${className}`.trim()}
      style={{
        paddingTop: metrics.topPadding,
        paddingLeft: metrics.horizontalInset,
        paddingRight: metrics.horizontalInset,
      }}
    >
      <View
        className={`flex items-center rounded-[20px] border border-white/35 bg-white/75 px-3 backdrop-blur-xl shadow-[0_10px_30px_rgba(124,58,237,0.08)] ${barClassName}`.trim()}
        style={{ height: metrics.contentHeight }}
      >
        <View
          className='flex shrink-0 items-center justify-start'
          style={{ width: resolvedSideWidth }}
        >
          {leftContent}
        </View>

        <View className='min-w-0 flex-1 px-3 text-center'>
          {title ? (
            <Text
              className={`block overflow-hidden text-ellipsis whitespace-nowrap text-base font-semibold leading-[1.4] text-gray-900 ${titleClassName}`.trim()}
            >
              {title}
            </Text>
          ) : null}
        </View>

        <View
          className='flex shrink-0 items-center justify-end'
          style={{ width: resolvedSideWidth }}
        >
          {rightContent}
        </View>
      </View>
    </View>
  );
}
