import { createHash } from 'node:crypto';
import type { FlowDefinition } from '@litter-bear/types/agent-flow';

/**
 * 计算忽略画布布局后的 FlowDefinition 语义摘要
 * @param definition 已通过结构校验的 FlowDefinition
 * @returns 返回 SHA-256 十六进制摘要
 * @description 对对象键按字典序规范化而保留数组顺序，保证同一 Flow 不因字段书写顺序或画布坐标变化产生不同版本摘要。
 */
export function calculateFlowDefinitionDigest(
  definition: FlowDefinition,
): string {
  const { layout: _layout, ...semanticDefinition } = definition;
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
