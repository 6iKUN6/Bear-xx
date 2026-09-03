import {
  getAdminImageUploadCredential,
  registerAdminImageAsset,
} from "./endpoints";
import type {
  AdminImageUploadCredential,
  AdminImageUploadUsage,
  StorageAsset,
} from "./types";

const AVATAR_MAX_SIZE = 2 * 1024 * 1024;
const SHARED_IMAGE_MAX_SIZE = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export interface UploadedAdminImage {
  key: string;
  accessUrl: string;
  mimeType: string;
}

export type AdminImageBinaryStage = "credential" | "uploading";

/**
 * 校验后台图片文件
 * @param file 浏览器选择的文件
 * @param usage 后台上传用途
 * @returns 校验通过返回 null，否则返回可直接展示的中文原因
 * @description 格式按扩展名闭集判断，大小按用途区分 10MB 与 2MB，并拒绝无法持久化的超长原文件名。
 */
export function validateAdminImageFile(
  file: File,
  usage: AdminImageUploadUsage,
): string | null {
  const ext = resolveImageExt(file);
  if (!ext || !IMAGE_EXTENSIONS.has(ext)) {
    return "仅支持 JPG、PNG、WebP 和 GIF 图片";
  }
  const normalizedMime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (normalizedMime && normalizedMime !== IMAGE_MIME_BY_EXTENSION[ext]) {
    return "文件扩展名与图片类型不一致";
  }
  if (file.name.length > 255) {
    return "文件名不能超过 255 个字符";
  }
  const maxSize =
    usage === "agent-avatar" ? AVATAR_MAX_SIZE : SHARED_IMAGE_MAX_SIZE;
  if (file.size <= 0) return "图片文件不能为空";
  if (file.size > maxSize) {
    return usage === "agent-avatar"
      ? "智能体头像不能超过 2MB"
      : "通用图片不能超过 10MB";
  }
  return null;
}

/**
 * 获取后台图片扩展名
 * @param file 浏览器文件
 * @returns 返回小写扩展名；无法识别时返回 null
 * @description 优先读取文件名，截图等无扩展名场景再按 MIME 映射，结果仍受后台格式闭集约束。
 */
export function resolveImageExt(file: File): string | null {
  const dotIndex = file.name.lastIndexOf(".");
  const fromName =
    dotIndex > 0 && dotIndex < file.name.length - 1
      ? file.name.slice(dotIndex + 1).toLowerCase()
      : null;
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const byMime: Readonly<Record<string, string>> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return byMime[file.type] ?? null;
}

/**
 * 将图片二进制直传 COS
 * @param file 已通过后台校验的图片文件
 * @param usage 图片用途
 * @param onStage 凭证签发和 PUT 开始时的阶段回调
 * @returns 返回上传后的 key、访问 URL 和签名确定的 MIME 类型
 * @description 只执行凭证签发与 PUT，不登记资产；调用方可在登记失败时保留 key 并只重试登记。
 */
export async function uploadAdminImageBinary(
  file: File,
  usage: AdminImageUploadUsage,
  onStage?: (stage: AdminImageBinaryStage) => void,
): Promise<UploadedAdminImage> {
  const validationError = validateAdminImageFile(file, usage);
  if (validationError) throw new Error(validationError);
  const ext = resolveImageExt(file);
  if (!ext) throw new Error("无法识别图片格式");

  onStage?.("credential");
  const credential = await getAdminImageUploadCredential({
    ext,
    usage,
    size: file.size,
  });
  onStage?.("uploading");
  await putFileToCredential(file, credential);
  const mimeType = credential.headers["Content-Type"];
  if (!mimeType) throw new Error("上传凭证缺少 Content-Type");

  return {
    key: credential.key,
    accessUrl: credential.accessUrl,
    mimeType,
  };
}

/**
 * 登记已上传的后台图片
 * @param file 原始浏览器文件
 * @param usage 图片用途
 * @param uploaded 已完成 PUT 的 key 与 MIME 信息
 * @returns 返回登记后的图片资产
 * @description 本方法不再次上传二进制，供首次登记和登记阶段失败后的精确重试共同使用。
 */
export function registerAdminUploadedImage(
  file: File,
  usage: AdminImageUploadUsage,
  uploaded: UploadedAdminImage,
): Promise<StorageAsset> {
  return registerAdminImageAsset({
    key: uploaded.key,
    usage,
    size: file.size,
    mimeType: uploaded.mimeType,
    originalName: file.name,
  });
}

/**
 * 上传智能体头像：拿预签名地址 → PUT 直传 COS（不经过 api 服务器）→ 登记资产。
 * 前端校验图片类型与 2MB 大小限制，上传请求只携带服务端签名指定的请求头。
 * @returns 返回可直接落库的访问 URL 与对象 key
 */
export async function uploadAgentAvatar(
  file: File,
): Promise<{ url: string; key: string }> {
  const uploaded = await uploadAdminImageBinary(file, "agent-avatar");
  await registerAdminUploadedImage(file, "agent-avatar", uploaded);
  return { url: uploaded.accessUrl, key: uploaded.key };
}

/**
 * 使用签名要求的请求头 PUT 单个文件
 * @param file 待上传图片
 * @param credential 后端签发的单对象凭证
 * @returns 上传成功时无返回值
 * @description 非 2xx 响应读取有限错误摘要并抛出，绝不进入资产登记阶段。
 */
async function putFileToCredential(
  file: File,
  credential: AdminImageUploadCredential,
): Promise<void> {
  const response = await fetch(credential.uploadUrl, {
    method: "PUT",
    headers: credential.headers,
    body: file,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `上传失败：${detail.slice(0, 200)}`
        : `上传失败(${response.status})`,
    );
  }
}
