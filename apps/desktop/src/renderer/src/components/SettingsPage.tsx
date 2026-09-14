import { ArrowLeft } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { ThemeMenu } from "@/components/ThemeMenu";

/** 设置页（独立页面）：外观主题 + 账号 + 关于 */
export function SettingsPage() {
  const setPage = useAppStore((s) => s.setPage);
  const user = useAppStore((s) => s.user);
  const logout = useAppStore((s) => s.logout);

  return (
    <div className="h-full overflow-y-auto px-6 pb-12 pt-7">
      <div className="mx-auto max-w-[600px]">
        <button
          type="button"
          onClick={() => setPage("workbench")}
          className="-ml-2.5 inline-flex items-center gap-1.5 rounded-[var(--lb-radius-sm)] px-2.5 py-1.5 text-[13px] text-[var(--lb-text-secondary)] transition-colors hover:bg-[var(--lb-surface-hover)] hover:text-[var(--lb-text-primary)]"
        >
          <ArrowLeft size={15} />
          返回
        </button>
        <h1 className="mb-1 mt-4 text-[22px] font-bold">设置</h1>
        <p className="mb-6 text-[13px] text-[var(--lb-text-secondary)]">
          外观与账号偏好，保存在本机。
        </p>

        <section className="mb-7">
          <div className="mb-2 text-[11px] text-[var(--lb-text-muted)]">外观 · 主题</div>
          <ThemeMenu />
        </section>

        <section className="mb-7">
          <div className="mb-2 text-[11px] text-[var(--lb-text-muted)]">账号</div>
          <div className="rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)]">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[var(--lb-accent-soft)] text-[13px] font-bold text-[var(--lb-accent-ink)]">
                {user ? user.nickname.charAt(0) : "?"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">
                  {user ? user.nickname : "未登录"}
                </div>
                <div className="text-[11px] text-[var(--lb-text-muted)]">
                  {user ? "已连接 · 会话与偏好同步中" : "登录后同步会话与偏好"}
                </div>
              </div>
              {user ? (
                <button
                  type="button"
                  onClick={() => {
                    void logout();
                  }}
                  className="inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] px-3.5 text-[13px] font-semibold transition-colors hover:bg-[var(--lb-surface-hover)]"
                >
                  退出登录
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setPage("login")}
                  className="lb-accent-surface inline-flex h-8 items-center rounded-[var(--lb-radius-sm)] px-3.5 text-[13px] font-semibold text-[var(--lb-on-accent)] transition-opacity hover:opacity-90"
                >
                  去登录
                </button>
              )}
            </div>
          </div>
        </section>

        <section>
          <div className="mb-2 text-[11px] text-[var(--lb-text-muted)]">关于</div>
          <div className="divide-y divide-[var(--lb-line-soft)] rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)]">
            {[
              ["Sola 桌面端", "v0.1.0 骨架"],
              ["运行时", "Sola Runtime（自托管）"],
              ["编排", "AgentFlow · Temporal"],
              [
                "外壳",
                window.sola
                  ? `Electron ${window.sola.versions.electron}`
                  : "浏览器调试（无 Electron 桥）",
              ],
            ].map(([key, value]) => (
              <div key={key} className="flex items-center gap-3 px-3.5 py-3">
                <div className="flex-1 text-[13px] text-[var(--lb-text-muted)]">{key}</div>
                <div className="text-[13px]">{value}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
