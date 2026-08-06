/**
 * 从模型输出中提取 JSON 文本
 * @param raw 模型原始输出
 * @returns 返回可供 JSON.parse 的片段；无法定位时返回 undefined
 * @description 兼容三种常见形态：纯 JSON、被 ``` / ```json 代码块包裹、JSON 前后带解释性杂文。
 * 取「首个 { 或 [」到「末个 } 或 ]」的贪婪切片——必须贪婪，非贪婪匹配遇到嵌套对象
 * （如 {"a":1,"meta":{"b":2}}）会在内层第一个 } 处截断，导致解析失败并静默降级。
 * 仅做定位不做校验，合法性交由调用方 JSON.parse + 字段校验。
 */
export function extractJsonText(raw: string): string | undefined {
  if (!raw) {
    return undefined;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;

  const firstObject = body.indexOf('{');
  const firstArray = body.indexOf('[');
  const starts = [firstObject, firstArray].filter((index) => index >= 0);
  if (starts.length === 0) {
    return undefined;
  }

  const start = Math.min(...starts);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (end <= start) {
    return undefined;
  }

  return body.slice(start, end + 1);
}

/**
 * 从模型输出中提取并解析 JSON 对象
 * @param raw 模型原始输出
 * @returns 返回解析后的值；定位失败或非法 JSON 时返回 undefined
 * @description 供各类"结构化输出"降级路径复用：结构化输出不可用时，模型仅受提示词约束，
 * 输出可能夹带杂文，需要先定位再解析。字段级校验仍由调用方负责。
 */
export function parseJsonFromText<T = unknown>(raw: string): T | undefined {
  const json = extractJsonText(raw);
  if (!json) {
    return undefined;
  }

  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}
