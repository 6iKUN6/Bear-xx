import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** 一次确认请求的参数。 */
interface ConfirmOptions {
  /** 标题，默认「确认操作」 */
  title?: string;
  /** 具体后果说明，必填——确认弹窗的价值就在于把代价讲清楚 */
  description: string;
  /** 确认按钮文案，默认「确认」 */
  confirmText?: string;
  /** 危险操作（删除/覆盖/回滚）置 true，确认键变红 */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

// 模块级单例：confirm() 是命令式 API，背后是这一个待决请求。
// 挂全局事件而非 React 状态提升，是为了让 confirm() 能在任何非组件上下文（如 mutation 回调）里直接 await。
let pending: PendingConfirm | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/**
 * 命令式确认弹窗，替代 window.confirm。
 * @returns Promise<boolean>：确认 true，取消/关闭 false
 * @example
 *   if (!(await confirm({ description: `删除「${name}」？`, danger: true }))) return;
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    pending = { ...options, resolve };
    emit();
  });
}

function settle(ok: boolean) {
  pending?.resolve(ok);
  pending = null;
  emit();
}

/**
 * ConfirmDialog 的宿主；在 AppShell 挂一次即可。
 * @description 订阅模块级 pending 请求，渲染居中确认弹窗。
 */
export function ConfirmHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  const req = pending;
  return (
    <Dialog open={!!req} onOpenChange={(open) => !open && settle(false)}>
      <DialogContent className="max-w-md gap-0 p-0">
        <div className="flex items-start gap-3 p-6 pb-2">
          <AlertTriangle
            className={
              req?.danger
                ? "mt-0.5 h-5 w-5 shrink-0 text-[var(--lb-danger)]"
                : "mt-0.5 h-5 w-5 shrink-0 text-[var(--lb-warning)]"
            }
          />
          <div className="min-w-0">
            <DialogTitle>{req?.title ?? "确认操作"}</DialogTitle>
            <DialogDescription className="mt-1.5 text-sm leading-relaxed text-foreground/80">
              {req?.description}
            </DialogDescription>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-6 pb-6 pt-2">
          <Button variant="outline" size="sm" onClick={() => settle(false)}>
            取消
          </Button>
          <Button
            variant={req?.danger ? "destructive" : "default"}
            size="sm"
            onClick={() => settle(true)}
          >
            {req?.confirmText ?? "确认"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
