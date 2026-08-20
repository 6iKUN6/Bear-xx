import type { TaskErrorCategory } from '@litter-bear/types/protocol';

/**
 * 结构化的 LLM / provider 错误描述
 * @description 从 OpenAI / Anthropic SDK 或底层网络错误中归一化出的可判定信息，
 * 供失败日志与 task.error 下发共用。message 面向用户，其余字段面向可观测与前端分类。
 */
export interface ClassifiedLlmError {
  message: string;
  name?: string;
  status?: number;
  code?: string;
  type?: string;
  category: TaskErrorCategory;
  retryable: boolean;
}

/** 可重试的错误类别 */
const RETRYABLE_CATEGORIES = new Set<TaskErrorCategory>([
  'rate_limit',
  'timeout',
  'network',
  'server',
]);

/**
 * 判断一个错误类别是否值得重试
 * @param category 协议闭集内的错误类别
 * @returns 属于限流/超时/网络/服务端时返回 true
 * @description 与 classifyLlmError 共用同一个集合。Flow 终态事件也要给出 retryable，
 * 在那边另抄一份清单必然与这里漂移——「同一事实只有一个源」。
 */
export function isRetryableTaskErrorCategory(
  category: TaskErrorCategory,
): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

/**
 * 归一化并分类 LLM / provider 错误
 * @param error 捕获到的任意错误
 * @returns 返回带类别与可重试判断的结构化错误
 * @description 优先用 HTTP 状态码判类（429=限流，401/403=鉴权，408=超时，4xx=非法，5xx=服务端），
 * 无状态码时回退到错误名与消息关键字（超时/网络）。任何无法归类的落到 unknown。
 */
export function classifyLlmError(error: unknown): ClassifiedLlmError {
  if (!(error instanceof Error)) {
    return {
      message: String(error),
      category: 'unknown',
      retryable: false,
    };
  }

  const record = error as unknown as Record<string, unknown>;
  const status =
    readNumber(record.status) ??
    readNumber(record.statusCode) ??
    readNumber(
      (record.response as Record<string, unknown> | undefined)?.status,
    );
  const code = typeof record.code === 'string' ? record.code : undefined;
  const type = typeof record.type === 'string' ? record.type : error.name;

  const category = resolveCategory(status, code, error);

  return {
    message: error.message,
    name: error.name,
    status,
    code,
    type,
    category,
    retryable: RETRYABLE_CATEGORIES.has(category),
  };
}

/**
 * 依据状态码与错误特征归类
 * @param status HTTP 状态码
 * @param code 错误代码（如 ETIMEDOUT / ECONNRESET）
 * @param error 原始错误
 * @returns 返回错误类别
 */
function resolveCategory(
  status: number | undefined,
  code: string | undefined,
  error: Error,
): TaskErrorCategory {
  if (status === 429) {
    return 'rate_limit';
  }
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 408) {
    return 'timeout';
  }
  if (status !== undefined && status >= 500) {
    return 'server';
  }
  if (status !== undefined && status >= 400) {
    return 'invalid';
  }

  const haystack = `${error.name} ${code ?? ''} ${error.message}`.toLowerCase();
  if (haystack.includes('timeout') || haystack.includes('etimedout')) {
    return 'timeout';
  }
  if (
    haystack.includes('econnreset') ||
    haystack.includes('econnrefused') ||
    haystack.includes('enotfound') ||
    haystack.includes('socket hang up') ||
    haystack.includes('network')
  ) {
    return 'network';
  }

  return 'unknown';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
