import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface AgentAvatarProps {
  name: string;
  avatar?: string | null;
  className?: string;
}

/** 在头像 URL 缺失或加载失败时展示智能体名称首字，避免显示碎图。 */
export function AgentAvatar({ name, avatar, className }: AgentAvatarProps) {
  const src = avatar?.trim() || null;
  const [hasImageError, setHasImageError] = useState(false);
  const initial = Array.from(name.trim())[0] ?? "?";

  useEffect(() => {
    setHasImageError(false);
  }, [src]);

  if (src && !hasImageError) {
    return (
      <img
        src={src}
        alt={name}
        className={cn(
          "shrink-0 rounded-full border border-border bg-muted object-cover",
          className,
        )}
        onError={() => setHasImageError(true)}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={name}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border border-border bg-muted text-sm font-medium text-muted-foreground",
        className,
      )}
    >
      {initial}
    </div>
  );
}

interface AgentIdentityProps {
  name: string;
  avatar: string | null;
  className?: string;
  compact?: boolean;
}

/** 在管理端列表和详情中一致展示智能体名称与头像。 */
export function AgentIdentity({
  name,
  avatar,
  className,
  compact = false,
}: AgentIdentityProps) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <AgentAvatar
        name={name}
        avatar={avatar}
        className={cn(
          compact ? "h-6 w-6" : "h-8 w-8",
        )}
      />
      <span
        className="truncate text-sm font-medium text-foreground"
        title={name}
      >
        {name}
      </span>
    </div>
  );
}
