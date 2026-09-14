import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Moon, Sun } from "lucide-react";
import { themes, type ThemeDefinition } from "@litter-bear/theme";
import { useThemeStore } from "@/stores/theme-store";

function Swatch({ theme }: { theme: ThemeDefinition }) {
  return (
    <span
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[var(--lb-radius-xs)] border border-[var(--lb-line-strong)] text-[10px] font-bold text-white"
      style={{
        background: `linear-gradient(135deg, ${theme.swatches[0]}, ${theme.swatches[1]} 55%, ${theme.swatches[2]})`,
      }}
      aria-hidden="true"
    >
      {theme.shortName}
    </span>
  );
}

/**
 * 主题下拉控件：当前主题 + 深浅模式选择（与 admin 同款模式语义：
 * 切主题跟随其默认模式，模式可手动覆盖；缺变体的主题回退默认色板）。
 */
export function ThemeMenu() {
  const themeId = useThemeStore((s) => s.themeId);
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setMode = useThemeStore((s) => s.setMode);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = themes.find((t) => t.id === themeId) ?? themes[0];

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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="切换主题"
        className="flex w-full items-center gap-2.5 rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-3 py-2.5 transition-colors hover:border-[var(--lb-line-strong)]"
      >
        <Swatch theme={current} />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[13px] font-semibold">
            {current.name}
          </span>
          <span className="block text-[11px] text-[var(--lb-text-muted)]">
            {mode === "dark" ? "深色模式" : "浅色模式"}
          </span>
        </span>
        <ChevronDown
          size={15}
          className={`shrink-0 text-[var(--lb-text-secondary)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] shadow-[var(--lb-shadow-glow)]">
          {themes.map((theme) => (
            <button
              key={theme.id}
              type="button"
              onClick={() => {
                setTheme(theme.id);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--lb-surface-hover)]"
            >
              <Swatch theme={theme} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">
                  {theme.name}
                </span>
                <span className="block text-[11px] text-[var(--lb-text-muted)]">
                  默认{theme.colorScheme === "dark" ? "深色" : "浅色"}
                </span>
              </span>
              {theme.id === themeId && (
                <Check size={14} className="shrink-0 text-[var(--lb-accent)]" />
              )}
            </button>
          ))}

          <div className="border-t border-[var(--lb-line-soft)] p-2">
            <div className="flex gap-1.5">
              {(
                [
                  { value: "light", label: "浅色", Icon: Sun },
                  { value: "dark", label: "深色", Icon: Moon },
                ] as const
              ).map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--lb-radius-sm)] text-[12px] font-semibold transition-colors ${
                    mode === value
                      ? "bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]"
                      : "text-[var(--lb-text-secondary)] hover:bg-[var(--lb-surface-hover)]"
                  }`}
                >
                  <Icon size={13} />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
