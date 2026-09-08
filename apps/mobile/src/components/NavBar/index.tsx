import type { ReactNode } from "react";
import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import AppIcon from "../AppIcon";
import { useNavBarMetrics } from "../../hooks/useNavBarMetrics";
import { appNavIconButtonClass, appSolidNavClass } from "../../utils/style";

export interface NavBarProps {
  title?: ReactNode | string;
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
  const reservedSideWidth =
    sideWidth ?? Math.max(metrics.sideWidth, metrics.capsuleWidth);
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

  const renderTitle = () => {
    if (title === undefined || title === null || title === false) {
      return null;
    }

    if (typeof title === "string" || typeof title === "number") {
      return (
        <Text
          className={`block overflow-hidden text-ellipsis whitespace-nowrap text-[1.0625rem] font-semibold leading-[1.25] text-[var(--lb-text-primary)] ${titleClassName}`.trim()}
        >
          {title}
        </Text>
      );
    }

    return (
      <View
        className={`flex min-w-0 items-center justify-center overflow-hidden text-[1.0625rem] font-semibold leading-[1.25] text-[var(--lb-text-primary)] ${titleClassName}`.trim()}
      >
        {title}
      </View>
    );
  };

  const leftContent =
    left !== undefined ? (
      left
    ) : showBack ? (
      <View className={appNavIconButtonClass} onClick={handleBack}>
        <AppIcon name="back" className="h-[1.125rem] w-[1.125rem]" />
      </View>
    ) : null;

  const rightContent =
    right !== undefined ? (
      right
    ) : shouldRenderCapsule ? (
      <View
        className={
          shouldShowCapsuleVisual
            ? "flex items-center justify-center rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface)]"
            : "opacity-0"
        }
        style={{
          width: metrics.capsuleWidth,
          height: metrics.capsuleHeight,
        }}
      >
        <View className="flex items-center gap-[0.375rem] text-[var(--lb-text-secondary)]">
          <View className="h-[0.25rem] w-[0.25rem] rounded-full bg-current" />
          <View className="h-[0.25rem] w-[0.25rem] rounded-full bg-current" />
          <View className="h-[0.75rem] w-[0.0625rem] rounded-full bg-current opacity-35" />
          <View className="h-[0.25rem] w-[0.25rem] rounded-full bg-current" />
        </View>
      </View>
    ) : null;

  const barVariantClass =
    variant === "ghost"
      ? "bg-transparent shadow-none border-transparent"
      : appSolidNavClass;

  return (
    <View
      className={`relative z-[20] px-[1rem] pb-[0rem] ${className}`.trim()}
      style={{
        paddingTop: metrics.topPadding,
        paddingLeft: metrics.horizontalInset,
        paddingRight: metrics.horizontalInset,
      }}
    >
      <View
        className={`flex items-center px-[0.75rem] ${barVariantClass} ${barClassName}`.trim()}
        style={{ height: metrics.contentHeight }}
      >
        <View
          className="flex shrink-0 items-center justify-start"
          style={{ width: reservedSideWidth }}
        >
          {leftContent}
        </View>

        <View className="min-w-0 flex-1 px-[0.625rem] text-center">
          {renderTitle()}
          {subtitle ? (
            <Text className="mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.2] text-[var(--lb-text-secondary)]">
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View
          className="flex shrink-0 items-center justify-end"
          style={{ width: reservedSideWidth }}
        >
          {rightContent}
        </View>
      </View>
    </View>
  );
}
