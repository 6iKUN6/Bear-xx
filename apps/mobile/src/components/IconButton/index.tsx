import { type ReactNode } from "react";
import { View } from "@tarojs/components";

interface IconButtonProps {
  icon: ReactNode;
  size?: "sm" | "md";
  variant?: "default" | "primary" | "ghost";
  /** 形状：square 圆角方块（默认）；round 正圆（悬浮胶囊输入条等场景） */
  shape?: "square" | "round";
  onClick?: () => void;
  className?: string;
}

export default function IconButton({
  icon,
  size = "md",
  variant = "ghost",
  shape = "square",
  onClick,
  className = "",
}: IconButtonProps) {
  const sizeClass =
    size === "sm" ? "h-[2.5rem] w-[2.5rem]" : "h-[2.5rem] w-[2.5rem]";
  const shapeClass =
    shape === "round" ? "rounded-full" : "rounded-[var(--lb-radius-md)]";
  const variantClass =
    variant === "default"
      ? "border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] text-[var(--lb-accent-ink)]"
      : variant === "primary"
        ? "bg-[var(--lb-accent-surface)] text-[var(--lb-on-accent)] shadow-[var(--lb-shadow-card)]"
        : "text-[var(--lb-text-secondary)]";

  return (
    <View
      className={`shrink-0 inline-flex items-center justify-center box-border transition-transform duration-150 active:scale-95 ${sizeClass} ${shapeClass} ${variantClass} ${className}`.trim()}
      onClick={onClick}
    >
      {icon}
    </View>
  );
}
