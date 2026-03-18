import { type ReactNode } from "react";
import { View } from "@tarojs/components";

interface IconButtonProps {
  icon: ReactNode;
  size?: "sm" | "md";
  variant?: "default" | "primary" | "ghost";
  onClick?: () => void;
  className?: string;
}

export default function IconButton({
  icon,
  size = "md",
  variant = "ghost",
  onClick,
  className = "",
}: IconButtonProps) {
  const sizeClass = size === "sm" ? "w-rpx-56 h-rpx-56" : "w-rpx-72 h-rpx-72";
  const variantClass =
    variant === "default"
      ? "bg-td-bg-soft text-td-brand"
      : variant === "primary"
        ? "bg-td-brand text-white shadow-td-sm"
        : "bg-td-bg-secondary border border-td-border-base text-td-text-secondary";

  return (
    <View
      className={`shrink-0 inline-flex items-center justify-center rounded-td-pill-rpx box-border transition-transform transition-colors duration-150 ${sizeClass} ${variantClass} ${className}`.trim()}
      onClick={onClick}
    >
      {icon}
    </View>
  );
}
