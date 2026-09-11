import { createHash } from 'node:crypto';
/**
 * 计算忽略画布布局后的 FlowDefinition 语义摘要
 * @param definition 已按其声明版本通过结构校验的 FlowDefinition 工件
 * @returns 返回 SHA-256 十六进制摘要
 * @description 同时接受当前与历史只读 schema 的解析结果。对对象键按字典序规范化而保留数组
 * 顺序，保证同一 Flow 不因字段书写顺序或画布坐标变化产生不同版本摘要；历史工件必须在迁移前
 * 调用，不能拿规范化后的当前版本对象冒充源版本摘要。
 */
export function calculateFlowDefinitionDigest(definition: object): string {
  const semanticDefinition = Object.fromEntries(
    Object.entries(definition).filter(([key]) => key !== 'layout'),
  );
  return createHash('sha256')
    .update(canonicalizeJson(semanticDefinition))
    .digest('hex');
}

/**
 * 将 JSON 值序列化为对象键稳定的规范字符串
 * @param value 任意可 JSON 序列化的 FlowDefinition 片段
 * @returns 返回稳定的 JSON 表示
 * @description 数组顺序保留其业务语义；对象键递归排序，使导入文件的字段排列不影响摘要。
 */
function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
