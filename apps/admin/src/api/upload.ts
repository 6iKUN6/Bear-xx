import { getUploadCredential, registerAsset } from "./endpoints";

const AVATAR_MAX_SIZE = 2 * 1024 * 1024;

/**
 * 上传智能体头像：拿直传凭证 → FormData 直传七牛（不经过 api 服务器）→ 登记资产。
 * 前端 2MB/图片类型校验只是即时反馈，服务端 putPolicy 有同等硬限制。
 * @returns 返回可直接落库的访问 URL 与对象 key
 */
export async function uploadAgentAvatar(
  file: File,
): Promise<{ url: string; key: string }> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请选择图片文件");
  }
  if (file.size > AVATAR_MAX_SIZE) {
    throw new Error("头像图片不能超过 2MB");
  }

  const ext = resolveExt(file);
  const credential = await getUploadCredential({
    type: "image",
    ext,
    usage: "agent-avatar",
  });

  const form = new FormData();
  form.append("token", credential.token);
  form.append("key", credential.key);
  form.append("file", file);

  const res = await fetch(credential.uploadUrl, { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((d: { error?: string }) => d.error)
      .catch(() => undefined);
    throw new Error(detail ? `上传失败：${detail}` : `上传失败(${res.status})`);
  }

  await registerAsset({
    key: credential.key,
    usage: "agent-avatar",
    size: file.size,
    mimeType: file.type,
  });

  return { url: credential.accessUrl, key: credential.key };
}

function resolveExt(file: File): string {
  const fromName = file.name.split(".").pop() ?? "";
  if (/^[a-z0-9]{1,8}$/i.test(fromName)) {
    return fromName.toLowerCase();
  }
  // 无扩展名（粘贴/截图场景）按 MIME 兜底
  const fromMime = file.type.split("/").pop() ?? "png";
  return /^[a-z0-9]{1,8}$/i.test(fromMime) ? fromMime : "png";
}
