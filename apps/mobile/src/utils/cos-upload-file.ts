/** 读取本地文件所需的最小微信文件系统能力。 */
export interface CosFileReader {
  readFile(options: {
    filePath: string;
    success?: (result: { data: string | ArrayBuffer }) => void;
    fail?: (error: { errMsg: string }) => void;
  }): void;
}

/**
 * 校验 COS PUT 上传响应状态。
 * @param statusCode COS 返回的 HTTP 状态码。
 * @returns 无返回值；2xx 状态视为上传成功。
 * @description COS 成功时可能返回 200 或 204，其他状态必须显式中止后续业务流程。
 */
export function assertCosUploadSucceeded(statusCode: number): void {
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`COS 上传失败(${statusCode})`);
  }
}

/**
 * 读取小程序本地文件的二进制数据。
 * @param filePath 微信上传前的临时文件路径。
 * @param fileReader 小程序文件系统管理器。
 * @returns 返回用于 PUT 请求的 ArrayBuffer。
 * @description FileSystemManager.readFile 是回调 API；不传 encoding 时应返回 ArrayBuffer，字符串结果会被拒绝以避免损坏二进制文件。
 */
export function readFileAsArrayBuffer(
  filePath: string,
  fileReader: CosFileReader,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    fileReader.readFile({
      filePath,
      success: ({ data }) => {
        if (data instanceof ArrayBuffer) {
          resolve(data);
          return;
        }

        reject(new Error("COS 上传文件读取结果不是二进制数据"));
      },
      fail: ({ errMsg }) => {
        reject(new Error(errMsg || "读取 COS 上传文件失败"));
      },
    });
  });
}
