import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Check, Copy, X } from "lucide-react";

export function Button({
  className = "",
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "quiet" | "danger";
}) {
  return (
    <button
      type="button"
      className={`ui-button ${variant} ${className}`}
      {...props}
    />
  );
}

export function IconButton({
  label,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-button ${className}`}
      {...props}
    />
  );
}

/** 原生 dialog 提供焦点约束、Esc 关闭及关闭后焦点归还。 */
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="ui-modal"
      aria-labelledby={heading}
      onCancel={onClose}
    >
      <div className="modal-heading">
        <h2 id={heading}>{title}</h2>
        <IconButton label="关闭弹窗" onClick={onClose}>
          <X size={17} />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}

export function Notice({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-notice" role="alert">
      <span>{children}</span>
      {action}
    </div>
  );
}

export function CopyButton({
  content,
  label = "复制",
}: {
  content: string;
  label?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <Button
      variant="quiet"
      onClick={() => {
        if (!navigator.clipboard) {
          setStatus("error");
          return;
        }
        void navigator.clipboard.writeText(content).then(
          () => setStatus("copied"),
          () => setStatus("error"),
        );
      }}
    >
      {status === "copied" ? <Check size={13} /> : <Copy size={13} />}
      {status === "copied"
        ? "已复制"
        : status === "error"
          ? "复制失败，请手动复制"
          : label}
    </Button>
  );
}
