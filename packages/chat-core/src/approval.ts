/**
 * HITL 审批卡的参数展示纯逻辑
 * @description 从移动端 ApprovalCard 抽出，供小程序与桌面端卡片共用；
 * 卡片 UI 本体各端自持（Taro 与 web DOM 是两套原语，不强行共享）。
 */

/** args 顶层标量事实行（一眼可读的键值对） */
export interface ApprovalArgFact {
  key: string;
  value: string;
}

/**
 * 把 args 拆成事实行与原始文本
 * @param args 序列化后的参数字符串
 * @returns facts：顶层标量键值对；rawText：完整 JSON（供折叠区展开）
 * @description 只把「一眼能读」的标量提成事实行；嵌套对象/数组不逐行展开，
 * 仍留在折叠的原始 JSON 里，避免把冗长结构摊到卡片上。
 */
export function splitApprovalArgs(args?: string): {
  facts: ApprovalArgFact[];
  rawText: string;
} {
  const rawText = formatApprovalArgs(args);
  if (!args) {
    return { facts: [], rawText: "" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return { facts: [], rawText };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { facts: [], rawText };
  }

  const facts: ApprovalArgFact[] = [];
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const scalar = toScalarText(value);
    if (scalar !== undefined) {
      facts.push({ key, value: scalar });
    }
  }
  return { facts, rawText };
}

/**
 * 标量转展示文本；嵌套结构/空值返回 undefined（不进事实行）
 */
function toScalarText(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() ? value : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/**
 * 格式化工具参数为易读 JSON
 * @param args 序列化后的参数字符串
 * @returns 美化后的 JSON 文本；非法则原样返回
 */
export function formatApprovalArgs(args?: string): string {
  if (!args) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}
