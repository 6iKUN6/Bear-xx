import { type ReactNode } from "react";
import { View } from "@tarojs/components";
import "./index.scss";

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
  return (
    <View
      className={`icon-button icon-button--${size} icon-button--${variant} ${className}`.trim()}
      onClick={onClick}
    >
      {icon}
    </View>
  );
}
