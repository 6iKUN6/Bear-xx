import {
  AlertCircle,
  CheckCircle2,
  FileImage,
  Loader2,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AdminImageUploadUsage } from "@/api/types";
import {
  registerAdminUploadedImage,
  uploadAdminImageBinary,
  validateAdminImageFile,
  type AdminImageBinaryStage,
  type UploadedAdminImage,
} from "@/api/upload";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatFileSize } from "@/lib/storage-meta";
import { cn } from "@/lib/utils";

type UploadItemStatus =
  | "ready"
  | "credential"
  | "uploading"
  | "registering"
  | "success"
  | "failed";

interface UploadQueueItem {
  id: string;
  file: File;
  status: UploadItemStatus;
  error: string | null;
  uploaded: UploadedAdminImage | null;
}

const STATUS_LABELS: Readonly<Record<UploadItemStatus, string>> = {
  ready: "等待上传",
  credential: "获取凭证",
  uploading: "上传 COS",
  registering: "登记资源",
  success: "上传成功",
  failed: "上传失败",
};

/**
 * 图片批量上传弹窗
 * @param props 弹窗状态与关闭回调
 * @returns 返回带三并发上传队列的管理弹窗
 * @description 每个文件独立流转；PUT 已成功但登记失败时保留 key，重试只调用登记接口。
 */
export function ImageUploadDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [usage, setUsage] =
    useState<AdminImageUploadUsage>("shared-image");
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [processing, setProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const usageLocked = queue.some(
    (item) => item.uploaded || item.status === "success",
  );

  const updateItem = (
    id: string,
    patch:
      | Partial<UploadQueueItem>
      | ((item: UploadQueueItem) => Partial<UploadQueueItem>),
  ) => {
    setQueue((items) =>
      items.map((item) =>
        item.id === id
          ? { ...item, ...(typeof patch === "function" ? patch(item) : patch) }
          : item,
      ),
    );
  };

  const addFiles = (files: FileList | File[]) => {
    const next = Array.from(files).map<UploadQueueItem>((file) => {
      const error = validateAdminImageFile(file, usage);
      return {
        id: crypto.randomUUID(),
        file,
        status: error ? "failed" : "ready",
        error,
        uploaded: null,
      };
    });
    setQueue((items) => [...items, ...next]);
  };

  const changeUsage = (nextUsage: AdminImageUploadUsage) => {
    setUsage(nextUsage);
    setQueue((items) =>
      items.map((item) => {
        const error = validateAdminImageFile(item.file, nextUsage);
        return {
          ...item,
          status: error ? "failed" : "ready",
          error,
        };
      }),
    );
  };

  /**
   * 处理单个队列项
   * @param item 开始处理时的队列快照
   * @returns 登记成功返回 true，失败返回 false
   * @description uploaded 存在时跳过凭证和 PUT，直接重试登记，避免同一文件产生第二个 COS 对象。
   */
  const processItem = async (item: UploadQueueItem): Promise<boolean> => {
    const validationError = validateAdminImageFile(item.file, usage);
    if (validationError) {
      updateItem(item.id, { status: "failed", error: validationError });
      return false;
    }

    let uploaded = item.uploaded;
    try {
      if (!uploaded) {
        uploaded = await uploadAdminImageBinary(
          item.file,
          usage,
          (stage: AdminImageBinaryStage) =>
            updateItem(item.id, { status: stage, error: null }),
        );
        updateItem(item.id, { uploaded, status: "registering" });
      } else {
        updateItem(item.id, { status: "registering", error: null });
      }

      await registerAdminUploadedImage(item.file, usage, uploaded);
      updateItem(item.id, { status: "success", error: null, uploaded });
      return true;
    } catch (error) {
      updateItem(item.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "上传失败",
        uploaded,
      });
      return false;
    }
  };

  /**
   * 以最多三个 worker 处理队列项
   * @param items 本轮待上传或重试的队列项
   * @returns 全部 worker 收敛后无返回值
   * @description 单项失败只返回 false，不打断其他 worker；本轮有任一成功即失效全部资源列表缓存。
   */
  const processItems = async (items: UploadQueueItem[]): Promise<void> => {
    if (items.length === 0) return;
    setProcessing(true);
    let cursor = 0;
    let anySuccess = false;
    const worker = async () => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        if (item && (await processItem(item))) anySuccess = true;
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(3, items.length) }, () => worker()),
      );
      if (anySuccess) {
        await queryClient.invalidateQueries({ queryKey: ["storageAssets"] });
      }
    } finally {
      setProcessing(false);
    }
  };

  const startAll = () => {
    const pending = queue.filter(
      (item) => item.status === "ready" || item.status === "failed",
    );
    if (pending.length === 0) {
      toast.info("没有待上传的图片");
      return;
    }
    void processItems(pending);
  };

  const close = () => {
    if (processing) {
      toast.warning("图片仍在上传，请等待本轮完成");
      return;
    }
    setQueue([]);
    setUsage("shared-image");
    setDragActive(false);
    onClose();
  };

  const successCount = queue.filter((item) => item.status === "success").length;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-3xl">
        <div className="space-y-1 pr-8">
          <DialogTitle>上传图片</DialogTitle>
          <DialogDescription>
            单次最多并发上传 3 张；失败图片可单独重试
          </DialogDescription>
        </div>

        <div className="grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">图片用途</label>
              <Select
                value={usage}
                onValueChange={(value) =>
                  changeUsage(value as AdminImageUploadUsage)
                }
                disabled={processing || usageLocked}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shared-image">通用图片</SelectItem>
                  <SelectItem value="agent-avatar">智能体头像</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {usage === "agent-avatar"
                  ? "最大 2MB，可在智能体头像选择器中复用"
                  : "最大 10MB，用于通用图片资源"}
              </p>
            </div>

            <button
              type="button"
              className={cn(
                "flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 text-center transition-colors",
                dragActive
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/60 hover:bg-muted/40",
              )}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                addFiles(event.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
              disabled={processing}
            >
              <Upload className="h-7 w-7 text-primary" />
              <span className="text-sm font-medium">拖放或选择图片</span>
              <span className="text-xs text-muted-foreground">
                JPG、PNG、WebP、GIF
              </span>
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".jpg,.jpeg,.png,.webp,.gif,image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={(event) => {
                if (event.currentTarget.files) addFiles(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </div>

          <div className="min-h-0">
            <div className="mb-2 flex h-7 items-center justify-between">
              <span className="text-sm font-medium">
                上传队列 {queue.length > 0 ? `(${successCount}/${queue.length})` : ""}
              </span>
              {successCount > 0 && !processing ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setQueue((items) =>
                      items.filter((item) => item.status !== "success"),
                    )
                  }
                >
                  清除已完成
                </Button>
              ) : null}
            </div>

            <div className="max-h-[23rem] min-h-52 space-y-2 overflow-y-auto pr-1">
              {queue.length === 0 ? (
                <div className="flex min-h-52 items-center justify-center rounded-md border border-border text-sm text-muted-foreground">
                  尚未选择图片
                </div>
              ) : (
                queue.map((item) => (
                  <UploadQueueRow
                    key={item.id}
                    item={item}
                    disabled={processing}
                    onRemove={() =>
                      setQueue((items) =>
                        items.filter((candidate) => candidate.id !== item.id),
                      )
                    }
                    onRetry={() => void processItems([item])}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">
            {processing ? "正在处理上传队列" : "关闭弹窗不会删除已成功的资源"}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={close} disabled={processing}>
              关闭
            </Button>
            <Button onClick={startAll} disabled={processing || queue.length === 0}>
              {processing ? <Loader2 className="animate-spin" /> : <Upload />}
              开始上传
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UploadQueueRow({
  item,
  disabled,
  onRemove,
  onRetry,
}: {
  item: UploadQueueItem;
  disabled: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const running = ["credential", "uploading", "registering"].includes(
    item.status,
  );
  return (
    <div className="flex min-h-16 items-center gap-3 rounded-md border border-border px-3 py-2">
      {item.status === "success" ? (
        <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--lb-success)]" />
      ) : item.status === "failed" ? (
        <AlertCircle className="h-5 w-5 shrink-0 text-[var(--lb-danger)]" />
      ) : running ? (
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
      ) : (
        <FileImage className="h-5 w-5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={item.file.name}>
          {item.file.name}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <Badge
            variant={
              item.status === "success"
                ? "success"
                : item.status === "failed"
                  ? "destructive"
                  : running
                    ? "info"
                    : "secondary"
            }
          >
            {STATUS_LABELS[item.status]}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {formatFileSize(item.file.size)}
          </span>
        </div>
        {item.error ? (
          <p className="mt-1 break-words text-xs text-[var(--lb-danger)]">
            {item.error}
          </p>
        ) : null}
      </div>
      {item.status === "failed" ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={item.uploaded ? "重新登记" : "重试上传"}
            onClick={onRetry}
            disabled={disabled}
          >
            <RotateCcw />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="移出队列"
            onClick={onRemove}
            disabled={disabled}
          >
            <Trash2 />
          </Button>
        </div>
      ) : item.status === "ready" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="移出队列"
          onClick={onRemove}
          disabled={disabled}
        >
          <Trash2 />
        </Button>
      ) : null}
    </div>
  );
}
