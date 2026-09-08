import {
  assertCosUploadSucceeded,
  readFileAsArrayBuffer,
  type CosFileReader,
} from "./cos-upload-file.js";
import { runInNewContext } from "node:vm";

function expectThrows(callback: () => void, message: string): void {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) {
      return;
    }

    throw error;
  }

  throw new Error(`期望抛出包含“${message}”的错误`);
}

function createReader(data: string | ArrayBuffer): CosFileReader {
  return {
    readFile({ success }) {
      success?.({ data });
    },
  };
}

function createFailedReader(errMsg: string): CosFileReader {
  return {
    readFile({ fail }) {
      fail?.({ errMsg });
    },
  };
}

async function run(): Promise<void> {
  expectThrows(() => assertCosUploadSucceeded(403), "COS 上传失败(403)");
  assertCosUploadSucceeded(204);

  const data = new ArrayBuffer(1);
  const result = await readFileAsArrayBuffer("/tmp/image.png", createReader(data));
  if (!(result instanceof ArrayBuffer)) {
    throw new Error("文件系统的 ArrayBuffer 结果应可用于上传");
  }

  const crossRealmData: ArrayBuffer = runInNewContext("new ArrayBuffer(1)");
  const crossRealmResult = await readFileAsArrayBuffer(
    "/tmp/cross-realm-image.png",
    createReader(crossRealmData),
  );
  if (Object.prototype.toString.call(crossRealmResult) !== "[object ArrayBuffer]") {
    throw new Error("跨 Realm 的 ArrayBuffer 结果应可用于上传");
  }

  await expectRejected(
    readFileAsArrayBuffer("/tmp/image.png", createReader("text")),
    "不是二进制数据",
  );
  await expectRejected(
    readFileAsArrayBuffer("/tmp/image.png", createFailedReader("读取失败")),
    "读取失败",
  );
}

async function expectRejected(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) {
      return;
    }

    throw error;
  }

  throw new Error(`期望 Promise 拒绝并包含“${message}”`);
}

void run();
