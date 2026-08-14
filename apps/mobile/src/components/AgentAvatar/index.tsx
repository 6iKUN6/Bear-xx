import { useEffect, useState } from "react";
import { Image, Text, View } from "@tarojs/components";
import { agentAvatarSrc, agentInitial } from "../../utils/agent";

interface AgentAvatarProps {
  name?: string | null;
  avatar?: string | null;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}

const INITIAL_SIZE_CLASSES = {
  xs: "text-[0.625rem]",
  sm: "text-[0.75rem]",
  md: "text-[0.875rem]",
  lg: "text-[1rem]",
} as const;

/** 智能体头像：头像 URL 为空或加载失败时显示名称首字。 */
export default function AgentAvatar({
  name,
  avatar,
  size = "sm",
  className = "",
}: AgentAvatarProps) {
  const avatarUrl = agentAvatarSrc(avatar);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [avatarUrl]);

  if (avatarUrl && !imageFailed) {
    return (
      <Image
        className={className}
        src={avatarUrl}
        mode="aspectFill"
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <View
      className={`flex items-center justify-center text-[var(--lb-text-secondary)] ${className}`.trim()}
    >
      <Text className={`${INITIAL_SIZE_CLASSES[size]} font-semibold leading-none`}>
        {agentInitial(name)}
      </Text>
    </View>
  );
}
