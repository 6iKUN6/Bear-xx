import Taro from "@tarojs/taro";
import { storageControllerRegisterAsset } from "../api/generated/client";
import { uploadToCos } from "./cos-upload";

const COMPRESSION_THRESHOLD_BYTES = 2 * 1024 * 1024;
export const CHAT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CHAT_IMAGE_MAX_EDGE = 2048;
const COMPRESSION_QUALITIES = [82, 75, 65] as const;

const IMAGE_FORMATS: Readonly<
  Record<string, { ext: string; mimeType: string }>
> = {
  jpg: { ext: "jpg", mimeType: "image/jpeg" },
  jpeg: { ext: "jpg", mimeType: "image/jpeg" },
  png: { ext: "png", mimeType: "image/png" },
  webp: { ext: "webp", mimeType: "image/webp" },
};

export interface PreparedChatImage {
  filePath: string;
  previewUrl: string;
  size: number;
  width: number;
  height: number;
  ext: string;
  mimeType: string;
}

export interface UploadedChatImage {
  imageAssetId: string;
  imageUrl: string;
}

/**
 * 将用户选择的图片收敛成聊天上传允许的格式和大小。
 * @description 大于 2 MiB、长边超过 2048px 或格式不在闭集时调用小程序压缩接口；
 * 依次降低 JPEG 质量，最终仍超过 4 MiB 或不能转成 JPEG/PNG/WebP 时明确拒绝。
 */
export async function prepareChatImage(
  filePath: string,
): Promise<PreparedChatImage> {
  let original: Awaited<ReturnType<typeof inspectImage>>;
  try {
    original = await inspectImage(filePath);
  } catch {
    return transcodeUnknownImage(filePath);
  }
  const requiresCompression =
    original.size > COMPRESSION_THRESHOLD_BYTES ||
    Math.max(original.width, original.height) > CHAT_IMAGE_MAX_EDGE ||
    !IMAGE_FORMATS[original.type.toLowerCase()];

  if (!requiresCompression) {
    return toPreparedImage(filePath, original);
  }

  const dimensions = scaleToLongEdge(
    original.width,
    original.height,
    CHAT_IMAGE_MAX_EDGE,
  );
  let lastError: Error | undefined;
  for (const quality of COMPRESSION_QUALITIES) {
    try {
      const compressed = await Taro.compressImage({
        src: filePath,
        quality,
        compressedWidth: dimensions.width,
        compressedHeight: dimensions.height,
      });
      const inspected = await inspectImage(compressed.tempFilePath);
      if (inspected.size <= CHAT_IMAGE_MAX_BYTES) {
        return toPreparedImage(compressed.tempFilePath, inspected);
      }
      lastError = new Error("压缩后的图片仍超过 4MB");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("图片压缩失败");
    }
  }
  throw lastError ?? new Error("图片压缩失败，请重新选择");
}

/** getImageInfo 无法识别 HEIC 等来源格式时，直接尝试由平台压缩接口转码。 */
async function transcodeUnknownImage(
  filePath: string,
): Promise<PreparedChatImage> {
  for (const quality of COMPRESSION_QUALITIES) {
    try {
      const compressed = await Taro.compressImage({ src: filePath, quality });
      const inspected = await inspectImage(compressed.tempFilePath);
      if (inspected.size <= CHAT_IMAGE_MAX_BYTES) {
        return toPreparedImage(compressed.tempFilePath, inspected);
      }
    } catch {
      // 继续尝试下一档质量；全部失败后统一给用户可执行的提示。
    }
  }
  throw new Error("图片格式转换失败，请重新选择 JPEG、PNG 或 WebP 图片");
}

/** 直传已处理图片并登记聊天资产，返回后端稳定资产 ID 与访问 URL。 */
export async function uploadChatImage(
  image: PreparedChatImage,
): Promise<UploadedChatImage> {
  const uploaded = await uploadToCos({
    filePath: image.filePath,
    type: "image",
    ext: image.ext,
  });
  const asset = await storageControllerRegisterAsset({
    key: uploaded.key,
    usage: "chat-image",
    size: image.size,
    mimeType: image.mimeType,
  });
  return { imageAssetId: asset.id, imageUrl: asset.url };
}

/** 按最长边等比计算压缩尺寸，不放大小图。 */
export function scaleToLongEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width, height };
  }
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

async function inspectImage(filePath: string): Promise<{
  width: number;
  height: number;
  size: number;
  type: string;
}> {
  const [image, file] = await Promise.all([
    Taro.getImageInfo({ src: filePath }),
    Taro.getFileInfo({ filePath }),
  ]);
  if (!("size" in file) || !Number.isFinite(file.size) || file.size <= 0) {
    throw new Error("无法读取图片大小");
  }
  return {
    width: image.width,
    height: image.height,
    size: file.size,
    type: image.type,
  };
}

function toPreparedImage(
  filePath: string,
  image: { width: number; height: number; size: number; type: string },
): PreparedChatImage {
  const format = IMAGE_FORMATS[image.type.toLowerCase()];
  if (!format) {
    throw new Error("图片格式转换失败，请选择 JPEG、PNG 或 WebP 图片");
  }
  if (image.size > CHAT_IMAGE_MAX_BYTES) {
    throw new Error("图片不能超过 4MB");
  }
  return {
    filePath,
    previewUrl: filePath,
    size: image.size,
    width: image.width,
    height: image.height,
    ...format,
  };
}
