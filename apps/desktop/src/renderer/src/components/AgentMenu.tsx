import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Bot } from "lucide-react";
import { useAgentStore } from "@/stores/agent-store";

function Avatar({ name, avatar }: { name: string; avatar: string | null }) {
  if (avatar) {
    return (
      <img
        src={avatar}
        alt=""
        className="h-[22px] w-[22px] shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--lb-accent-soft)] text-[11px] font-bold text-[var(--lb-accent-ink)]">
      {name.charAt(0)}
    </span>
  );
}

/**
 * 智能体选择下拉：切换本条消息由哪个智能体回答（Flow 随智能体绑定走）。
 * 选中项只影响接下来发送的消息；「默认」表示不带 agentId、用后端路由。
 * 会员不可用的智能体置灰不可选。
 */
export function AgentMenu() {
  const agents = useAgentStore((s) => s.agents);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const selectAgent = useAgentStore((s) => s.selectAgent);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = agents.find((a) => a.id === selectedAgentId) ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    // capture 阶段拦截 Esc，避免冒泡到 App 的全局 Esc（返回工作台）
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

  if (agents.length === 0) {
    return null;
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="选择智能体"
        className="flex h-8 items-center gap-1.5 rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-2.5 text-[12px] font-semibold text-[var(--lb-text-secondary)] transition-colors hover:border-[var(--lb-line-strong)] hover:text-[var(--lb-text-primary)]"
      >
        {selected ? (
          <Avatar name={selected.name} avatar={selected.avatar} />
        ) : (
          <Bot size={13} />
        )}
        <span className="max-w-[120px] truncate">
          {selected ? selected.name : "默认智能体"}
        </span>
        <ChevronDown
          size={13}
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full z-20 mb-1.5 w-[240px] overflow-hidden rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] shadow-[var(--lb-shadow-glow)]">
          <button
            type="button"
            onClick={() => {
              selectAgent(null);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--lb-surface-hover)]"
          >
            <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--lb-surface-hover)] text-[var(--lb-text-secondary)]">
              <Bot size={13} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">默认智能体</span>
              <span className="block text-[11px] text-[var(--lb-text-muted)]">
                由后端路由决定
              </span>
            </span>
            {selectedAgentId === null && (
              <Check size={14} className="shrink-0 text-[var(--lb-accent)]" />
            )}
          </button>

          {agents.map((agent) => {
            const usable = agent.canUse;
            return (
              <button
                key={agent.id}
                type="button"
                disabled={!usable}
                onClick={() => {
                  if (!usable) {
                    return;
                  }
                  selectAgent(agent.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  usable
                    ? "hover:bg-[var(--lb-surface-hover)]"
                    : "cursor-not-allowed opacity-50"
                }`}
              >
                <Avatar name={agent.name} avatar={agent.avatar} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">
                    {agent.name}
                    {agent.isDefault && (
                      <span className="ml-1 text-[10px] text-[var(--lb-text-muted)]">默认</span>
                    )}
                  </span>
                  {agent.description && (
                    <span className="block truncate text-[11px] text-[var(--lb-text-muted)]">
                      {usable ? agent.description : "当前会员不可用"}
                    </span>
                  )}
                </span>
                {agent.id === selectedAgentId && (
                  <Check size={14} className="shrink-0 text-[var(--lb-accent)]" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
