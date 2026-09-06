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
}: {
  providerKey: ModelProviderKey;
  name: string;
  className?: string;
}) {
  const logo = PROVIDER_LOGOS[providerKey];
  return (
    <span
      className={cn(
        "grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-white",
        className,
      )}
      aria-hidden="true"
    >
      {logo ? (
        <img src={logo} alt="" className="h-6 w-6 object-contain" />
      ) : providerKey === "custom-openai" ? (
        <Cable className="h-5 w-5 text-muted-foreground" />
      ) : (
        <span className="text-xs font-semibold text-muted-foreground">
          {name.slice(0, 2)}
        </span>
      )}
    </span>
  );
}
