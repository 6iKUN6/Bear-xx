import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { ApiError } from "@/api/client";
import { BrandTile } from "@/components/BrandTile";

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{4,20}$/;
const PASSWORD_MIN_LENGTH = 8;

/**
 * 登录页（独立页面）：C 端 /auth/account/login 账号密码登录。
 * 注意后端语义：账号不存在时会用当前密码自动注册并直接登录。
 */
export function LoginPage() {
  const setPage = useAppStore((s) => s.setPage);
  const login = useAppStore((s) => s.login);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usernameValid = USERNAME_PATTERN.test(username.trim());
  const passwordValid = password.length >= PASSWORD_MIN_LENGTH;
  const canSubmit = usernameValid && passwordValid && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "网络异常，请确认 API 服务可达后重试",
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex h-full items-center justify-center">
      <button
        type="button"
        onClick={() => setPage("workbench")}
        className="absolute left-6 top-[18px] inline-flex items-center gap-1.5 rounded-[var(--lb-radius-sm)] px-2.5 py-1.5 text-[13px] text-[var(--lb-text-secondary)] transition-colors hover:bg-[var(--lb-surface-hover)] hover:text-[var(--lb-text-primary)]"
      >
        <ArrowLeft size={15} />
        返回
      </button>

      <div className="w-[320px] text-center">
        <BrandTile size={56} />
        <h1 className="mt-4 text-[22px] font-bold">登录 Sola</h1>
        <p className="mb-6 mt-1.5 text-[13px] text-[var(--lb-text-secondary)]">
          首次使用的账号名会自动注册
        </p>
        <form onSubmit={(e) => void handleSubmit(e)} noValidate>
          <input
            type="text"
            maxLength={20}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="账号名"
            aria-label="账号名"
            autoComplete="username"
            className="mb-1 h-11 w-full rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] bg-[var(--lb-surface)] px-3.5 text-sm outline-none placeholder:text-[var(--lb-text-muted)] focus:border-[var(--lb-accent)]"
          />
          <div className="mb-2 h-4 text-left text-xs text-[var(--lb-danger)]" aria-live="polite">
            {username && !usernameValid ? "4–20 位，仅限字母、数字、下划线" : ""}
          </div>
          <input
            type="password"
            maxLength={64}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            aria-label="密码"
            autoComplete="current-password"
            className="mb-1 h-11 w-full rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] bg-[var(--lb-surface)] px-3.5 text-sm outline-none placeholder:text-[var(--lb-text-muted)] focus:border-[var(--lb-accent)]"
          />
          <div className="mb-2 h-4 text-left text-xs text-[var(--lb-danger)]" aria-live="polite">
            {password && !passwordValid ? "密码至少 8 位" : ""}
          </div>
          <button
            type="submit"
            disabled={!canSubmit}
            className="lb-accent-surface mt-1 h-11 w-full rounded-[var(--lb-radius-sm)] text-[15px] font-semibold text-[var(--lb-on-accent)] transition-opacity hover:opacity-90 disabled:bg-[var(--lb-surface-hover)] disabled:text-[var(--lb-text-muted)]"
          >
            {submitting ? "登录中…" : "登 录"}
          </button>
        </form>
        <p className="mt-3.5 h-4 text-xs text-[var(--lb-danger)]" aria-live="polite">
          {error ?? ""}
        </p>
      </div>
    </div>
  );
}
