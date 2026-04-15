import type { ReactNode } from "react";
import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useNavBarMetrics } from "../../hooks/useNavBarMetrics";

interface NavBarProps {
  title?: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
  showBack?: boolean;
  onBack?: () => void;
  className?: string;
  barClassName?: string;
  titleClassName?: string;
  sideWidth?: number;
  variant?: "glass" | "ghost";
  capsule?: "auto" | "visible" | "hidden";
}

export default function NavBar({
  title,
  subtitle,
  left,
  right,
  showBack = true,
  onBack,
  className = "",
  barClassName = "",
  titleClassName = "",
  sideWidth,
  variant = "glass",
  capsule = "auto",
}: NavBarProps) {
  const metrics = useNavBarMetrics();
  const reservedSideWidth = sideWidth ?? Math.max(metrics.sideWidth, metrics.capsuleWidth);
  const shouldRenderCapsule = capsule !== "hidden" && right === undefined;
  const shouldShowCapsuleVisual =
    capsule === "visible" || (capsule === "auto" && !metrics.isWeapp);

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
        className='flex h-[40px] w-[40px] items-center justify-center rounded-[12px] bg-white/70 text-[18px] text-[var(--lb-text-primary)] shadow-[0_8px_24px_rgba(124,58,237,0.12)] backdrop-blur-[16px]'
        onClick={handleBack}
      >
        <Text className='at-icon at-icon-chevron-left leading-none [&::before]:block' />
      </View>
    ) : null;

  const rightContent =
    right !== undefined ? (
      right
    ) : shouldRenderCapsule ? (
      <View
        className={shouldShowCapsuleVisual ? "app-nav-capsule" : "opacity-0"}
        style={{
          width: metrics.capsuleWidth,
          height: metrics.capsuleHeight,
        }}
      >
        <View className='app-nav-capsule__inner'>
          <View className='app-nav-capsule__dot' />
          <View className='app-nav-capsule__dot' />
          <View className='app-nav-capsule__line' />
          <View className='app-nav-capsule__dot' />
        </View>
      </View>
    ) : null;

  const barVariantClass =
    variant === "ghost"
      ? "bg-transparent shadow-none border-transparent backdrop-blur-[0px]"
      : "app-solid-nav bg-white";

  return (
    <View
      className={`relative z-[20] px-[16px] pb-[0px] ${className}`.trim()}
      style={{
        paddingTop: metrics.topPadding,
        paddingLeft: metrics.horizontalInset,
        paddingRight: metrics.horizontalInset,
      }}
    >
      <View
        className={`flex items-center px-[12px] ${variant === "glass" ? "rounded-none" : "rounded-[22px]"} ${barVariantClass} ${barClassName}`.trim()}
        style={{ height: metrics.contentHeight }}
      >
        <View
          className='flex shrink-0 items-center justify-start'
          style={{ width: reservedSideWidth }}
        >
          {leftContent}
        </View>

        <View className='min-w-0 flex-1 px-[10px] text-center'>
          {title ? (
            <Text
              className={`block overflow-hidden text-ellipsis whitespace-nowrap text-[17px] font-semibold leading-[1.25] text-[var(--lb-text-primary)] ${titleClassName}`.trim()}
            >
              {title}
            </Text>
          ) : null}
          {subtitle ? (
            <Text className='mt-[2px] block overflow-hidden text-ellipsis whitespace-nowrap text-[12px] leading-[1.2] text-[var(--lb-text-secondary)]'>
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View
          className='flex shrink-0 items-center justify-end'
          style={{ width: reservedSideWidth }}
        >
          {rightContent}
        </View>
      </View>
    </View>
  );
}
