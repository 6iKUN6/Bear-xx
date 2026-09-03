import type {
  StorageAsset,
  StorageAssetStatus,
} from "@/api/types";
import type { BadgeProps } from "@/components/ui/badge";

export const STORAGE_USAGE_OPTIONS = [
  { value: "shared-image", label: "通用图片" },
  { value: "agent-avatar", label: "智能体头像" },
  { value: "chat-image", label: "聊天图片" },
  { value: "ai-image", label: "AI 生图" },
] as const;

const USAGE_NAMES = new Map<string, string>(
  STORAGE_USAGE_OPTIONS.map((option) => [option.value, option.label]),
);

const STATUS_META: Readonly<
  Record<
    StorageAssetStatus,
    { label: string; variant: BadgeProps["variant"] }
  >
> = {
  ACTIVE: { label: "可用", variant: "success" },
  BROKEN: { label: "失效", variant: "warning" },
  DELETED: { label: "已删除", variant: "secondary" },
};

/** 返回用途中文名；未知用途原样显示，避免伪装成已有分类。 */
export function storageUsageName(usage: string): string {
  return (USAGE_NAMES.get(usage) ?? usage) || "未分类";
}

/** 返回资产状态对应的中文名和 Badge 变体。 */
export function storageStatusMeta(status: StorageAssetStatus) {
  return STATUS_META[status];
}

/** 原文件名为空的历史记录显示随机 key 的最后一段。 */
export function storageAssetDisplayName(asset: StorageAsset): string {
  return asset.originalName || asset.key.split("/").at(-1) || asset.key;
}

/** 将字节数格式化为后台易读的 KB/MB。 */
export function formatFileSize(size: number | null): string {
  if (size == null) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
