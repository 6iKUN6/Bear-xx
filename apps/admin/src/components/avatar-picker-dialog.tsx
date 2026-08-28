import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAvatarAssets } from "@/hooks/queries";
import { cn } from "@/lib/utils";

/**
 * 已上传头像选择器
 * @param props 开关状态、当前选中的 URL 与选择回调
 * @returns 返回一个独立的小弹窗
 * @description 从智能体表单里拆出来：此前它是内联展开的一块网格，把表单顶得很长，
 * 且和上传按钮挤在同一行。选头像是个独立的短决策，用弹窗比就地展开更合适。
 *
 * 资源只在弹窗打开时才请求（`useAvatarAssets(open)`），避免每次开表单都拉一次列表。
 */
export function AvatarPickerDialog({
  open,
  currentUrl,
  onSelect,
  onClose,
}: {
  open: boolean;
  currentUrl?: string | null;
  onSelect: (url: string) => void;
  onClose: () => void;
}) {
  const { data: assets, isLoading } = useAvatarAssets(open);
  const items = assets ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <div className="space-y-1">
          <DialogTitle>选择已上传的头像</DialogTitle>
          <DialogDescription>
            点击即选用；关闭弹窗不会改动当前头像
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              加载中…
            </p>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              还没有已上传的头像，先在表单里上传一张
            </p>
          ) : (
            <div className="grid grid-cols-5 gap-2 pr-1">
              {items.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  title={asset.key}
                  onClick={() => {
                    onSelect(asset.url);
                    onClose();
                  }}
                  className={cn(
                    "overflow-hidden rounded-md border p-0 transition-colors",
                    currentUrl === asset.url
                      ? "border-primary ring-2 ring-primary/40"
                      : "border-border hover:border-primary/50",
                  )}
                >
                  <img
                    src={asset.url}
                    alt=""
                    className="aspect-square w-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
