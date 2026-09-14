import { Plus, Settings } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { BrandTile } from "@/components/BrandTile";

/** 会话按更新时间分组（同小程序的分组语义） */
function groupOf(updatedAt: number): string {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (updatedAt >= startOfToday) {
    return "今天";
  }
  if (updatedAt >= startOfToday - dayMs) {
    return "昨天";
  }
  if (updatedAt >= startOfToday - 7 * dayMs) {
    return "七天内";
  }
  return "更早";
}

const GROUP_ORDER = ["今天", "昨天", "七天内", "更早"];

/** 左侧栏：品牌 + 新对话 + 会话分组列表 + 底部账号/设置入口 */
export function Sidebar() {
  const user = useAppStore((s) => s.user);
  const setPage = useAppStore((s) => s.setPage);
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const loading = useChatStore((s) => s.loading);
  const loadError = useChatStore((s) => s.loadError);
  const loadConversations = useChatStore((s) => s.loadConversations);
  const setActive = useChatStore((s) => s.setActive);

  const groups = GROUP_ORDER.map((label) => ({
    label,
    items: conversations.filter((c) => groupOf(c.updatedAt) === label),
  })).filter((g) => g.items.length > 0);

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)]">
      <div className="flex items-center gap-2.5 px-4 pb-2.5 pt-4">
        <BrandTile size={32} />
        <div>
          <div className="text-[15px] font-bold">Sola</div>
          <div className="text-[11px] text-[var(--lb-text-muted)]">AI 工作台</div>
        </div>
      </div>

      <div className="px-2 pb-1">
        <button
          type="button"
          onClick={() => setActive(null)}
          className="flex w-full items-center gap-2 rounded-[var(--lb-radius-sm)] px-2.5 py-2 text-[13px] font-semibold transition-colors hover:bg-[var(--lb-surface-hover)]"
        >
          <Plus size={14} className="text-[var(--lb-text-secondary)]" />
          新对话
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3 pt-1" aria-label="会话列表">
        {loadError ? (
          <div className="px-2.5 pt-2 text-[12px] text-[var(--lb-danger)]">
            <p>{loadError}</p>
            <button
              type="button"
              onClick={() => void loadConversations()}
              className="mt-1.5 rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] px-2.5 py-1 text-[var(--lb-text-primary)] transition-colors hover:bg-[var(--lb-surface-hover)]"
            >
              重试
            </button>
          </div>
        ) : loading && conversations.length === 0 ? (
          <div className="px-2.5 pt-2 text-[12px] text-[var(--lb-text-muted)]">
            加载会话中…
          </div>
        ) : null}

        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 pb-1 pt-2.5 text-[11px] text-[var(--lb-text-muted)]">
              {group.label}
            </div>
            {group.items.map((conv) => (
              <button
                key={conv.id}
                type="button"
                onClick={() => setActive(conv.id)}
                className={`w-full rounded-[var(--lb-radius-sm)] px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-[var(--lb-surface-hover)] ${
                  conv.id === activeId
                    ? "bg-[var(--lb-surface-hover)] font-semibold"
                    : ""
                }`}
              >
                <span className="block truncate">{conv.title}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--lb-line-soft)] p-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPage(user ? "settings" : "login")}
            aria-label="登录 / 账号"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--lb-radius-sm)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--lb-surface-hover)]"
          >
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[var(--lb-accent-soft)] text-[13px] font-bold text-[var(--lb-accent-ink)]">
              {user ? user.nickname.charAt(0) : "?"}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold">
                {user ? user.nickname : "未登录"}
              </span>
              <span className="block text-[11px] text-[var(--lb-text-muted)]">
                {user ? "账号已连接" : "点击登录账号"}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setPage("settings")}
            aria-label="设置"
            title="设置"
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[var(--lb-radius-sm)] text-[var(--lb-text-secondary)] transition-colors hover:bg-[var(--lb-surface-hover)]"
          >
            <Settings size={17} />
          </button>
        </div>
      </div>
    </aside>
  );
}
