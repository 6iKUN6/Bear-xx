import defaultAgentAvatar from "@litter-bear/assets/agents/default-avatar.png";
import { cn } from "@/lib/utils";

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
      <img
        src={avatar || defaultAgentAvatar}
        alt=""
        className={cn(
          "shrink-0 rounded-full border border-border bg-muted object-cover",
          compact ? "h-6 w-6" : "h-8 w-8",
        )}
        onError={(event) => {
          event.currentTarget.src = defaultAgentAvatar;
        }}
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
