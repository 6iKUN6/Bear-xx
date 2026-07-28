/**
 * 节点摘要合成器
 *
 * 把 agent loop 各关键节点（工具调用、计划、步骤）归约成一句面向用户的中文摘要，
 * 例如 "已使用 getWeather，成功查询到深圳天气"、"任务清单创建完成，共 3 步"。
 *
 * 设计约束：
 * - 规则路径零延迟、确定性，覆盖结构已知的工具与计划/步骤节点。
 * - 未注册工具走通用兜底文案；出参非结构化、规则拼不出时，交由上层的 LLM 路径二次总结。
 * - 只产出 `summary`（语义化一句话），不替代 `publicStatus`（进行中的粗粒度状态）。
 */

const MAX_SUMMARY_LENGTH = 120;

/** 工具结果提取器：从入参与出参中拼出「做了什么、结果如何」 */
export interface ToolResultExtractor {
  /**
   * @param args 工具入参（已解析为对象；解析失败时为 undefined）
   * @param output 工具出参（已尽量结构化；可能是对象、字符串或 undefined）
   * @returns 返回一句摘要；返回 undefined 表示放弃规则合成，交由上层兜底或 LLM 总结
   */
  (
    args: Record<string, unknown> | undefined,
    output: unknown,
  ): string | undefined;
}

/**
 * 已知工具的结果提取器注册表
 * @description key 为工具名。新增结构已知的工具时在此登记，即可产出更自然的摘要。
 */
const TOOL_RESULT_EXTRACTORS: Record<string, ToolResultExtractor> = {
  getWeather: (args, output) => {
    const city = readString(args, ['city', 'location', 'place']);
    const cityLabel = city ? `${city}天气` : '天气';
    return readObjectLike(output)
      ? `成功查询到${cityLabel}`
      : `已查询${cityLabel}`;
  },
  webSearch: (args) => {
    const query = readString(args, ['query']);
    return query ? `已联网搜索「${query}」` : '已完成联网搜索';
  },
};

/**
 * 合成工具调用成功摘要
 * @param toolName 工具名
 * @param rawArgs 工具入参（字符串或对象；字符串会尝试 JSON 解析）
 * @param output 工具出参
 * @returns 返回形如 "已使用 getWeather，成功查询到深圳天气" 的摘要
 * @description 命中注册表则用专用提取器；否则用通用兜底 "已使用 {toolName}，调用完成"。
 */
export function buildToolDoneSummary(
  toolName: string | undefined,
  rawArgs: unknown,
  output: unknown,
): string {
  const name = toolName?.trim() || '工具';
  const args = parseArgs(rawArgs);
  const extractor = toolName ? TOOL_RESULT_EXTRACTORS[toolName] : undefined;
  const detail = extractor?.(args, output);
  const tail = detail ?? '调用完成';
  return truncate(`已使用 ${name}，${tail}`);
}

/**
 * 合成工具调用失败摘要
 * @param toolName 工具名
 * @param error 错误信息（字符串或带 message 的对象）
 * @returns 返回形如 "getWeather 调用失败：城市不存在" 的摘要
 */
export function buildToolErrorSummary(
  toolName: string | undefined,
  error: unknown,
): string {
  const name = toolName?.trim() || '工具';
  const reason = readErrorMessage(error);
  return truncate(reason ? `${name} 调用失败：${reason}` : `${name} 调用失败`);
}

/**
 * 合成计划创建完成摘要
 * @param stepCount 计划步骤数
 * @returns 返回形如 "任务清单创建完成，共 3 步" 的摘要
 */
export function buildPlanReadySummary(stepCount: number | undefined): string {
  if (typeof stepCount === 'number' && stepCount > 0) {
    return `任务清单创建完成，共 ${stepCount} 步`;
  }
  return '任务清单创建完成';
}

/**
 * 合成单步完成摘要
 * @param index 步骤序号（从 1 开始；缺省时省略序号）
 * @param goal 步骤目标描述
 * @returns 返回形如 "第 2 步完成：已获取天气数据" 的摘要
 */
export function buildStepDoneSummary(
  index: number | undefined,
  goal: string | undefined,
): string {
  const goalLabel = goal?.trim();
  const prefix =
    typeof index === 'number' && index > 0 ? `第 ${index} 步完成` : '步骤完成';
  return truncate(goalLabel ? `${prefix}：${goalLabel}` : prefix);
}

/**
 * 解析工具入参
 * @param rawArgs 原始入参（字符串或对象）
 * @returns 返回解析后的对象；无法解析为对象时返回 undefined
 */
function parseArgs(rawArgs: unknown): Record<string, unknown> | undefined {
  if (readObjectLike(rawArgs)) {
    return rawArgs as Record<string, unknown>;
  }
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      return readObjectLike(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 从对象中读取第一个命中的字符串字段
 * @param source 源对象
 * @param keys 候选键（按优先级）
 * @returns 返回命中的非空字符串；无命中返回 undefined
 */
function readString(
  source: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!source) {
    return undefined;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * 读取错误信息文本
 * @param error 字符串或带 message 的对象
 * @returns 返回错误文本；无法识别时返回 undefined
 */
function readErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string' && error.trim()) {
    return truncate(error.trim());
  }
  if (readObjectLike(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      return truncate(message.trim());
    }
  }
  return undefined;
}

/**
 * 判断是否为非空的普通对象（排除数组与 null）
 * @param value 任意值
 * @returns 是普通对象返回 true
 */
function readObjectLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 截断过长摘要
 * @param text 原始文本
 * @returns 超过上限时截断并追加省略号
 */
function truncate(text: string): string {
  return text.length > MAX_SUMMARY_LENGTH
    ? `${text.slice(0, MAX_SUMMARY_LENGTH)}...`
    : text;
}
