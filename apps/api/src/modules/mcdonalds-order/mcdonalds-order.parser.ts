import type { ParsedMcDonaldsOrder } from './mcdonalds-order.types';

const PAYMENT_URL_KEYS = new Set([
  'payh5url',
  'payurl',
  'paymenturl',
  'paymentlink',
]);
const PAYMENT_URL_EXPIRES_AT_KEYS = new Set([
  'payh5urlexpiresat',
  'payurlexpiresat',
  'paymenturlexpiresat',
  'paymentlinkexpiresat',
]);

/**
 * 解析麦当劳 MCP 工具响应
 * @param raw MCP 工具返回的未知响应内容
 * @returns 返回识别到的订单字段、支付链接与已脱敏快照
 * @description MCP 未声明稳定的结果 schema，因此只提升明确字段名；支付链接在任何持久化或返回前均会从安全快照删除。
 */
export function parseMcDonaldsOrderResponse(
  raw: unknown,
): ParsedMcDonaldsOrder {
  const normalized = normalizeToolOutput(raw);
  const safeSnapshot = stripPaymentUrls(normalized);

  return {
    externalOrderId: findStringByKeys(safeSnapshot, [
      'orderid',
      'orderno',
      'ordernumber',
    ]),
    paymentUrl: findPaymentUrl(normalized),
    paymentUrlExpiresAt: findPaymentUrlExpiresAt(normalized),
    safeSnapshot,
    status: findStringByKeys(safeSnapshot, ['orderstatus', 'status']),
    items: findArrayByKeys(safeSnapshot, ['items', 'itemlist', 'products']),
  };
}

function normalizeToolOutput(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    return asRecord(parseJsonString(raw) ?? { text: raw });
  }

  if (!isRecord(raw)) {
    return { value: raw ?? null };
  }

  if (typeof raw.content === 'string') {
    const parsedContent = parseJsonString(raw.content);
    if (parsedContent && isRecord(parsedContent)) {
      return parsedContent;
    }
  }

  return cloneRecord(raw);
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function findPaymentUrl(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findPaymentUrl(item);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    if (isPaymentUrlKey(key) && typeof child === 'string' && child.trim()) {
      return child.trim();
    }
    const match = findPaymentUrl(child);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function findPaymentUrlExpiresAt(value: unknown): Date | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findPaymentUrlExpiresAt(item);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    if (!PAYMENT_URL_EXPIRES_AT_KEYS.has(key.toLowerCase())) {
      continue;
    }
    const parsed = parseDate(child);
    if (parsed) {
      return parsed;
    }
  }

  for (const child of Object.values(value)) {
    const match = findPaymentUrlExpiresAt(child);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function stripPaymentUrls(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(value);
  return isRecord(sanitized) ? sanitized : { value: sanitized ?? null };
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isPaymentUrlKey(key)) {
      result[key] = sanitizeValue(child);
    }
  }
  return result;
}

function findStringByKeys(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  return findValueByKeys(value, keys, (candidate) =>
    typeof candidate === 'string' && candidate.trim()
      ? candidate.trim()
      : undefined,
  );
}

function findArrayByKeys(
  value: unknown,
  keys: readonly string[],
): unknown[] | undefined {
  return findValueByKeys(value, keys, (candidate) =>
    Array.isArray(candidate) ? candidate : undefined,
  );
}

function findValueByKeys<T>(
  value: unknown,
  keys: readonly string[],
  accept: (candidate: unknown) => T | undefined,
): T | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findValueByKeys(item, keys, accept);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key.toLowerCase())) {
      const accepted = accept(child);
      if (accepted !== undefined) {
        return accepted;
      }
    }
  }

  for (const child of Object.values(value)) {
    const match = findValueByKeys(child, keys, accept);
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function isPaymentUrlKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    PAYMENT_URL_KEYS.has(normalized) ||
    (normalized.includes('payment') &&
      (normalized.endsWith('url') || normalized.endsWith('link')))
  );
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? cloneRecord(value) : { value: value ?? null };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneValue(child)]),
  );
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  return isRecord(value) ? cloneRecord(value) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
