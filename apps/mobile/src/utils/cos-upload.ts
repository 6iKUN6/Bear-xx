import Taro from "@tarojs/taro";
import { storageControllerCreateCosUploadCredential } from "../api/generated/client";
import type { CosUploadCredentialDtoType } from "../api/generated/models";
import {
  assertCosUploadSucceeded,
  readFileAsArrayBuffer,
} from "./cos-upload-file";

export {
  assertCosUploadSucceeded,
  readFileAsArrayBuffer,
} from "./cos-upload-file";
export type { CosFileReader } from "./cos-upload-file";

/** 小程序 COS 直传所需的本地文件信息。 */
export interface CosUploadInput {
  /** 微信小程序临时文件路径。 */
  filePath: string;
  /** 文件媒体类别，由后端决定对象目录与允许的 MIME 类型。 */
  type: CosUploadCredentialDtoType;
  /** 文件扩展名，不含点。 */
  ext: string;
}

/** COS 直传成功后可持久化的对象信息。 */
export interface CosUploadedObject {
  /** COS 对象 key。 */
  key: string;
  /** COS 或 CDN 的访问地址。 */
  url: string;
}

/**
 * 通过短期预签名 URL 将小程序本地文件直传到腾讯云 COS。
 * @param input 本地文件路径、媒体类型和扩展名。
 * @returns 返回可使用的对象 key 与访问 URL。
 * @description 先由已鉴权的业务 API 签发单对象 PUT 凭证，再直接向 COS 上传二进制；上传请求只透传服务端签名的请求头，不携带 Bearer Token，也不走七牛资产登记。
 */
export async function uploadToCos(
  input: CosUploadInput,
): Promise<CosUploadedObject> {
  const credential = await storageControllerCreateCosUploadCredential({
    type: input.type,
    ext: input.ext,
  });
  const data = await readFileAsArrayBuffer(
    input.filePath,
    Taro.getFileSystemManager(),
  );
  const response = await Taro.request<string, ArrayBuffer>({
    url: credential.uploadUrl,
    method: "PUT",
    data,
    header: credential.headers,
    responseType: "text",
  });

  assertCosUploadSucceeded(response.statusCode);

  return {
    key: credential.key,
    url: credential.accessUrl,
  };
}
