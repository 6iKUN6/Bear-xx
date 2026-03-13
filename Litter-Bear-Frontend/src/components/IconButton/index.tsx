import { type ReactNode } from "react";
import { View } from "@tarojs/components";

interface IconButtonProps {
  icon: ReactNode;
  size?: "sm" | "md";
  variant?: "default" | "primary" | "ghost";
  onClick?: () => void;
  className?: string;
}

const sizeMap = {
  sm: "w-[56rpx] h-[56rpx]",
  md: "w-[72rpx] h-[72rpx]",
};

const variantMap = {
  default: "bg-td-bg-soft text-td-brand",
  primary: "bg-td-brand text-white shadow-td-sm",
  ghost: "bg-td-bg-secondary text-td-text-secondary border border-td-border-base",
};

export default function IconButton({
  icon,
  size = "md",
  variant = "ghost",
  onClick,
  className = "",
}: IconButtonProps) {
  return (
    <View
      className={`flex-shrink-0 rounded-full flex items-center justify-center active:scale-95 transition-transform duration-150 ${sizeMap[size]} ${variantMap[variant]} ${className}`}
      onClick={onClick}
    >
      {icon}
    </View>
  );
}
