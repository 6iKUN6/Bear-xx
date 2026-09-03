import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  ImageOff,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { FormEvent, useState } from "react";
import { toast } from "sonner";
import type { StorageAsset, StorageAssetStatus } from "@/api/types";
import { ApiError } from "@/api/client";
import { ImageUploadDialog } from "@/components/image-upload-dialog";
import {
  downloadStorageAsset,
  ImagePreviewDialog,
} from "@/components/image-preview-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useStorageAssetMutations,
  useStorageAssets,
} from "@/hooks/queries";
import { formatTime } from "@/lib/format";
import {
  formatFileSize,
  STORAGE_USAGE_OPTIONS,
  storageAssetDisplayName,
  storageStatusMeta,
  storageUsageName,
} from "@/lib/storage-meta";
import { cn } from "@/lib/utils";
import { confirm } from "@/components/confirm-dialog";

const PAGE_SIZE = 24;

export function ResourcesPage() {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [usage, setUsage] = useState("ALL");
  const [status, setStatus] = useState<StorageAssetStatus | "ALL">("ACTIVE");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<StorageAsset | null>(null);
  const [updatingIds, setUpdatingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const query = useStorageAssets({
    page,
    pageSize: PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(usage !== "ALL" ? { usage } : {}),
    ...(status !== "ALL" ? { status } : {}),
  });
  const { status: statusMutation } = useStorageAssetMutations();
  const data = query.data;

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  };

  const clearSearch = () => {
    setSearchInput("");
    setSearch("");
    setPage(1);
  };

  const markUpdating = (id: string, updating: boolean) =>
    setUpdatingIds((ids) => {
      const next = new Set(ids);
      if (updating) next.add(id);
      else next.delete(id);
      return next;
    });

  const updateStatus = async (
    asset: StorageAsset,
    nextStatus: "ACTIVE" | "DELETED",
  ) => {
    if (
      nextStatus === "DELETED" &&
      !(await confirm({
        description: `确定将「${storageAssetDisplayName(asset)}」移入已删除？`,
        danger: true,
      }))
    ) {
      return;
    }
    markUpdating(asset.id, true);
    try {
      await statusMutation.mutateAsync({ id: asset.id, status: nextStatus });
      toast.success(nextStatus === "ACTIVE" ? "资源已恢复" : "资源已删除");
      if (status !== "ALL" && data?.items.length === 1 && page > 1) {
        setPage(page - 1);
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : nextStatus === "ACTIVE"
            ? "恢复失败"
            : "删除失败",
      );
    } finally {
      markUpdating(asset.id, false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">图片资源</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data ? `共 ${data.total.toLocaleString("zh-CN")} 张图片` : "统一管理已登记图片"}
          </p>
        </div>
        <div className="flex items-center gap-2 self-start lg:self-auto">
          <Button
            variant="outline"
            size="icon"
            title="刷新资源列表"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={cn(query.isFetching && "animate-spin")} />
          </Button>
          <Button onClick={() => setUploadOpen(true)}>
            <Upload />
            上传图片
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-y border-border py-4 lg:flex-row lg:items-center">
        <form className="flex min-w-0 flex-1 gap-2" onSubmit={submitSearch}>
          <div className="relative min-w-0 flex-1">
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索原文件名或对象 key"
              className="pr-9"
              maxLength={100}
            />
            {searchInput ? (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground"
                onClick={clearSearch}
                title="清空搜索"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <Button type="submit" variant="outline" title="搜索">
            <Search />
            搜索
          </Button>
        </form>

        <div className="grid grid-cols-2 gap-2 lg:flex">
          <Select
            value={usage}
            onValueChange={(value) => {
              setUsage(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full lg:w-[9.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部用途</SelectItem>
              {STORAGE_USAGE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as StorageAssetStatus | "ALL");
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full lg:w-[8.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">可用</SelectItem>
              <SelectItem value="BROKEN">失效</SelectItem>
              <SelectItem value="DELETED">已删除</SelectItem>
              <SelectItem value="ALL">全部状态</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {query.isLoading ? (
        <ResourceGridSkeleton />
      ) : query.isError ? (
        <div className="flex min-h-64 flex-col items-center justify-center gap-3 border border-[var(--lb-danger)] bg-[var(--lb-danger-soft)] px-6 text-center">
          <ImageOff className="h-8 w-8 text-[var(--lb-danger)]" />
          <div>
            <p className="font-medium text-foreground">资源列表加载失败</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {query.error instanceof ApiError
                ? query.error.message
                : "请检查网络或存储服务状态"}
            </p>
          </div>
          <Button variant="outline" onClick={() => void query.refetch()}>
            <RefreshCw />
            重试
          </Button>
        </div>
      ) : data && data.items.length > 0 ? (
        <>
          <div
            className={cn(
              "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
              query.isFetching && "opacity-70",
            )}
          >
            {data.items.map((asset) => (
              <ResourceCard
                key={asset.id}
                asset={asset}
                updating={updatingIds.has(asset.id)}
                onPreview={() => setPreviewAsset(asset)}
                onStatusChange={(nextStatus) =>
                  void updateStatus(asset, nextStatus)
                }
              />
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-border pt-4">
            <span className="text-sm text-muted-foreground">
              第 {data.page} / {Math.max(data.totalPages, 1)} 页
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon"
                title="上一页"
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                disabled={page <= 1 || query.isFetching}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon"
                title="下一页"
                onClick={() => setPage((value) => value + 1)}
                disabled={page >= data.totalPages || query.isFetching}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="flex min-h-64 flex-col items-center justify-center gap-2 border-y border-border text-center">
          <ImageOff className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium text-foreground">没有符合条件的图片</p>
          <p className="text-sm text-muted-foreground">
            调整搜索或筛选条件后重试
          </p>
        </div>
      )}

      <ImageUploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
      <ImagePreviewDialog
        asset={previewAsset}
        onClose={() => setPreviewAsset(null)}
      />
    </div>
  );
}

function ResourceCard({
  asset,
  updating,
  onPreview,
  onStatusChange,
}: {
  asset: StorageAsset;
  updating: boolean;
  onPreview: () => void;
  onStatusChange: (status: "ACTIVE" | "DELETED") => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const status = storageStatusMeta(asset.status);
  const name = storageAssetDisplayName(asset);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(asset.url);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败，请检查浏览器剪贴板权限");
    }
  };

  const download = async () => {
    try {
      await downloadStorageAsset(asset);
      toast.success("已开始下载");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败");
    }
  };

  return (
    <article
      className={cn(
        "overflow-hidden rounded-md border border-border bg-card",
        asset.status !== "ACTIVE" && "opacity-75",
      )}
    >
      <button
        type="button"
        className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-muted"
        onClick={onPreview}
        title="预览图片"
      >
        {imageFailed ? (
          <span className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
            <ImageOff className="h-7 w-7" />
            图片加载失败
          </span>
        ) : (
          <img
            src={asset.url}
            alt={name}
            className="h-full w-full object-cover transition-transform duration-200 hover:scale-[1.02]"
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        )}
      </button>

      <div className="space-y-3 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={name}>
            {name}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={asset.key}>
            {asset.key}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{storageUsageName(asset.usage)}</Badge>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{formatFileSize(asset.size)}</span>
          <span>{formatTime(asset.createdAt)}</span>
        </div>

        <div className="flex justify-end gap-1 border-t border-border pt-2">
          <Button variant="ghost" size="icon" title="预览" onClick={onPreview}>
            <Eye />
          </Button>
          <Button variant="ghost" size="icon" title="复制链接" onClick={copyUrl}>
            <Copy />
          </Button>
          <Button variant="ghost" size="icon" title="下载" onClick={download}>
            <Download />
          </Button>
          {asset.status === "ACTIVE" ? (
            <Button
              variant="ghost"
              size="icon"
              title="软删除"
              onClick={() => onStatusChange("DELETED")}
              disabled={updating}
            >
              {updating ? <Loader2 className="animate-spin" /> : <Trash2 />}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              title="恢复为可用"
              onClick={() => onStatusChange("ACTIVE")}
              disabled={updating}
            >
              {updating ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function ResourceGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="overflow-hidden rounded-md border border-border">
          <Skeleton className="aspect-[4/3] w-full rounded-none" />
          <div className="space-y-3 p-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
