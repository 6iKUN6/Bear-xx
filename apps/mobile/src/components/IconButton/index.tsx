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
  const sizeClass =
    size === "sm" ? "h-[2.5rem] w-[2.5rem]" : "h-[2.5rem] w-[2.5rem]";
  const variantClass =
    variant === "default"
      ? "border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] text-[var(--lb-accent-ink)]"
      : variant === "primary"
        ? `${appGradientSurfaceClass} shadow-[var(--lb-shadow-glow)]`
        : "border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] text-[var(--lb-text-secondary)]";

  return (
    <View
      className={`shrink-0 inline-flex items-center justify-center rounded-[var(--lb-radius-md)] box-border transition-transform duration-150 active:scale-95 ${sizeClass} ${variantClass} ${className}`.trim()}
      onClick={onClick}
    >
      {icon}
    </View>
  );
}
