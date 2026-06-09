import { type ReactNode } from "react";
import { View } from "@tarojs/components";
import { appGradientSurfaceClass } from "../../utils/style";

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
  const sizeClass = size === "sm" ? "h-[2.5rem] w-[2.5rem]" : "h-[2.5rem] w-[2.5rem]";
  const variantClass =
    variant === "default"
      ? "bg-white text-[var(--lb-grad-a)] shadow-[0_0.375rem_1.125rem_rgba(124,58,237,0.06)]"
      : variant === "primary"
        ? `${appGradientSurfaceClass} shadow-[0_0.75rem_1.5rem_rgba(124,58,237,0.24)]`
        : "bg-white text-[var(--lb-text-secondary)] shadow-[0_0.375rem_1.125rem_rgba(124,58,237,0.06)] border border-[rgba(196,181,253,0.18)]";

  return (
    <View
      className={`shrink-0 inline-flex items-center justify-center rounded-[0.75rem] box-border transition-transform duration-150 active:scale-95 ${sizeClass} ${variantClass} ${className}`.trim()}
      onClick={onClick}
    >
      {icon}
    </View>
  );
}
