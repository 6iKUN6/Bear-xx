import { Copy, Download, ImageOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { StorageAsset } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatTime } from "@/lib/format";
import {
  formatFileSize,
  storageAssetDisplayName,
  storageStatusMeta,
  storageUsageName,
} from "@/lib/storage-meta";

/**
 * 下载已登记图片
 * @param asset 待下载图片资源
 * @returns 下载完成时无返回值
 * @description 通过资源 URL 读取 Blob 并使用原文件名下载；跨域或 HTTP 失败时抛出真实错误。
 */
export async function downloadStorageAsset(asset: StorageAsset): Promise<void> {
  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(`下载失败(${response.status})`);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = storageAssetDisplayName(asset);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

/** 图片资源大图预览与完整元数据弹窗。 */
export function ImagePreviewDialog({
  asset,
  onClose,
}: {
  asset: StorageAsset | null;
  onClose: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const status = asset ? storageStatusMeta(asset.status) : null;

  const copyUrl = async () => {
    if (!asset) return;
    try {
      await navigator.clipboard.writeText(asset.url);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败，请检查浏览器剪贴板权限");
    }
  };

  const download = async () => {
    if (!asset) return;
    try {
      await downloadStorageAsset(asset);
      toast.success("已开始下载");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败");
    }
  };

  return (
    <Dialog
      open={Boolean(asset)}
      onOpenChange={(open) => {
        if (!open) {
          setImageFailed(false);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-4xl">
        {asset ? (
          <>
            <div className="space-y-1 pr-8">
              <DialogTitle className="truncate">
                {storageAssetDisplayName(asset)}
              </DialogTitle>
              <DialogDescription>图片预览与登记信息</DialogDescription>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
                <div className="flex min-h-72 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
                  {imageFailed ? (
                    <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                      <ImageOff className="h-8 w-8" />
                      图片加载失败
                    </div>
                  ) : (
                    <img
                      src={asset.url}
                      alt={storageAssetDisplayName(asset)}
                      className="max-h-[62vh] w-full object-contain"
                      onError={() => setImageFailed(true)}
                    />
                  )}
                </div>

                <dl className="space-y-4 text-sm">
                  <MetaRow label="用途" value={storageUsageName(asset.usage)} />
                  <div>
                    <dt className="text-xs text-muted-foreground">状态</dt>
                    <dd className="mt-1">
                      <Badge variant={status?.variant}>{status?.label}</Badge>
                    </dd>
                  </div>
                  <MetaRow label="文件大小" value={formatFileSize(asset.size)} />
                  <MetaRow label="MIME" value={asset.mimeType ?? "未知"} />
                  <MetaRow label="上传时间" value={formatTime(asset.createdAt)} />
                  <MetaRow label="对象 key" value={asset.key} breakAll />
                  <MetaRow label="访问 URL" value={asset.url} breakAll />
                </dl>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button variant="outline" onClick={copyUrl}>
                <Copy />
                复制链接
              </Button>
              <Button onClick={download}>
                <Download />
                下载
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MetaRow({
  label,
  value,
  breakAll = false,
}: {
  label: string;
  value: string;
  breakAll?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={breakAll ? "mt-1 break-all" : "mt-1"}>{value}</dd>
    </div>
  );
}
