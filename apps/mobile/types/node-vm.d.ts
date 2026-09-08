declare module "node:vm" {
  /** 在独立 V8 Realm 中执行测试夹具，并返回该 Realm 创建的 ArrayBuffer。 */
  export function runInNewContext(code: string): ArrayBuffer;
}
