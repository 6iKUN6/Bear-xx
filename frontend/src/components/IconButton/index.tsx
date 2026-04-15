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
  const sizeClass = size === "sm" ? "h-[40px] w-[40px]" : "h-[40px] w-[40px]";
  const variantClass =
    variant === "default"
      ? "bg-white text-[var(--lb-grad-a)] shadow-[0_6px_18px_rgba(124,58,237,0.06)]"
      : variant === "primary"
        ? "app-gradient-surface text-white shadow-[0_12px_24px_rgba(124,58,237,0.24)]"
        : "bg-white text-[var(--lb-text-secondary)] shadow-[0_6px_18px_rgba(124,58,237,0.06)] border border-[rgba(196,181,253,0.18)]";

  return (
    <View
      className={`shrink-0 inline-flex items-center justify-center rounded-[12px] box-border transition-transform duration-150 active:scale-95 ${sizeClass} ${variantClass} ${className}`.trim()}
      onClick={onClick}
    >
      {icon}
    </View>
  );
}
