import { Cable } from "lucide-react";
import type { ModelProviderKey } from "@/api/types";
import { cn } from "@/lib/utils";

const PROVIDER_LOGOS: Partial<Record<ModelProviderKey, string>> = {
  openai: "/model-providers/openai.svg",
  anthropic: "/model-providers/anthropic.svg",
  deepseek: "/model-providers/deepseek.svg",
  kimi: "/model-providers/kimi.svg",
  "kimi-coding": "/model-providers/kimi.svg",
  doubao: "/model-providers/doubao.svg",
  google: "/model-providers/google.svg",
  qwen: "/model-providers/qwen.svg",
  zhipu: "/model-providers/zhipu.svg",
  minimax: "/model-providers/minimax.svg",
  openrouter: "/model-providers/openrouter.svg",
};

export function ModelProviderLogo({
  providerKey,
  name,
  className,
  size = "md",
}: {
  providerKey: ModelProviderKey;
  name: string;
  className?: string;
  /** sm 用于画布节点徽章等小尺寸场景；md 为列表/表单的默认尺寸 */
  size?: "sm" | "md";
}) {
  const logo = PROVIDER_LOGOS[providerKey];
  const small = size === "sm";
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-white",
        small ? "h-5 w-5" : "h-10 w-10",
        className,
      )}
      aria-hidden="true"
    >
      {logo ? (
        <img
          src={logo}
          alt=""
          className={cn("object-contain", small ? "h-3.5 w-3.5" : "h-6 w-6")}
        />
      ) : providerKey === "custom-openai" ? (
        <Cable
          className={cn(
            "text-muted-foreground",
            small ? "h-3 w-3" : "h-5 w-5",
          )}
        />
      ) : (
        <span
          className={cn(
            "font-semibold text-muted-foreground",
            small ? "text-[9px]" : "text-xs",
          )}
        >
          {name.slice(0, 2)}
        </span>
      )}
    </span>
  );
}
