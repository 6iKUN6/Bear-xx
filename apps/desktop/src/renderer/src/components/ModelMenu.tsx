import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import { useModelStore } from "@/stores/model-store";

interface ModelMenuProps {
  /** 当前生效的智能体 id；null = 后端默认路由（无具体 agent，不出模型选项） */
  agentId: string | null;
}

/**
 * 模型预设选择下拉
 * @description 数据源 GET /agents/:id/models；自定义 Flow Agent 的 models 为空时不渲染。
 * 只负责模型单选；思考开关 / 强度 / 预算拆到 ThinkingMenu。选择仅影响下一条消息，
 * 服务端发送时仍会按允许集合与能力目录重新校验。
 */
export function ModelMenu({ agentId }: ModelMenuProps) {
  const options = useModelStore((s) => (agentId ? s.optionsByAgent[agentId] : undefined));
  const selection = useModelStore((s) =>
    agentId ? s.selectionByAgent[agentId] : undefined,
  );
  const ensureOptions = useModelStore((s) => s.ensureOptions);
  const selectModel = useModelStore((s) => s.selectModel);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (agentId) {
      void ensureOptions(agentId);
    }
  }, [agentId, ensureOptions]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeydown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeydown, true);
    };
  }, [open]);

  const selectedModel = options?.models.find(
    (m) => m.modelPresetId === selection?.modelPresetId,
  );

  // 自定义 Flow Agent（无模型选项）或选项未就绪时不渲染入口
  if (!options || options.models.length === 0 || !selectedModel || !selection) {
    return null;
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="模型预设"
        className="flex h-8 items-center gap-1.5 rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-2.5 text-[12px] font-semibold text-[var(--lb-text-secondary)] transition-colors hover:border-[var(--lb-line-strong)] hover:text-[var(--lb-text-primary)]"
      >
        <Cpu size={13} />
        <span className="max-w-[140px] truncate">{selectedModel.name}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full z-20 mb-1.5 w-[280px] overflow-hidden rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] shadow-[var(--lb-shadow-glow)]">
          <div className="max-h-[300px] overflow-y-auto p-1.5">
            <div className="flex flex-col">
              {options.models.map((model) => {
                const active = model.modelPresetId === selection.modelPresetId;
                return (
                  <button
                    key={model.modelPresetId}
                    type="button"
                    onClick={() => agentId && selectModel(agentId, model)}
                    className={`flex items-center justify-between gap-2 rounded-[var(--lb-radius-sm)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--lb-surface-hover)] ${
                      active ? "bg-[var(--lb-accent-soft)]" : ""
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">
                        {model.name}
                      </span>
                      <span className="block truncate text-[11px] text-[var(--lb-text-muted)]">
                        {model.providerKey} · {model.model}
                      </span>
                    </span>
                    {active && (
                      <Check size={14} className="shrink-0 text-[var(--lb-accent)]" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
