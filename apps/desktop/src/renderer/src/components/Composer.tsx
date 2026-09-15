import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { Button, Notice } from "./ui";

export function Composer({
  value,
  onChange,
  onSend,
  controls,
  placeholder = "说说你的想法…",
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  controls?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
}) {
  const user = useAppStore((s) => s.user);
  const sending = useChatStore((s) => s.sending);
  const taskId = useChatStore((s) => s.taskId);
  const canceling = useChatStore((s) => s.canceling);
  const error = useChatStore((s) => s.taskError);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = "auto";
    input.current.style.height = `${Math.min(input.current.scrollHeight, 180)}px`;
  }, [value]);
  return (
    <div className="composer-area">
      {error && <Notice>{error}</Notice>}
      {!user && (
        <div className="login-hint">
          <span>登录后使用 AI 助手</span>
          <Button
            variant="quiet"
            onClick={() => useAppStore.getState().setPage("login")}
          >
            去登录
          </Button>
        </div>
      )}
      <div className="composer">
        <textarea
          ref={input}
          aria-label="输入消息"
          rows={2}
          value={value}
          maxLength={20000}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (user && !sending && !disabled && value.trim()) onSend();
            }
          }}
        />
        <div className="composer-bottom">
          <div className="min-w-0 flex-1">{controls}</div>
          {sending ? (
            <button
              type="button"
              className="send-button stop"
              disabled={!taskId || canceling}
              onClick={() => void useChatStore.getState().cancel()}
              aria-label="停止当前生成"
              title={taskId ? "停止当前生成" : "正在连接，获取任务后可停止"}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="send-button"
              aria-label="发送"
              disabled={!user || disabled || !value.trim()}
              onClick={onSend}
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
      <p className="composer-note">
        {sending
          ? canceling
            ? "正在停止…"
            : "任务进行中，可切换页面继续编辑"
          : "Enter 发送 · Shift + Enter 换行"}
      </p>
    </div>
  );
}
