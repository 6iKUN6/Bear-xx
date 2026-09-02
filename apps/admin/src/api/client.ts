import { authStorage } from "./auth-storage";
import type { AuthResponse } from "./types";

const API_BASE_URL =
  // 默认走 IPv4：macOS 上 localhost 优先解析 ::1，若有其它进程绑在
  // [::1]:3000（如别的项目的 dev server）请求会被劫持并表现为 CORS 报错
  (import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000").replace(
    /\/+$/,
    "",
  );

/** 后端统一响应信封 */
interface Envelope<T> {
  code: number;
  data: T;
  message: string;
  errorCode?: string;
}

/** 服务端给出的单条结构化错误明细。 */
export interface ApiErrorDetail {
  /** 出错字段路径，例如 `nodes.2.config.cases.0.conditions.0.ref` */
  path: string;
  /** 违反的规则名，例如 `ref-dominates` */
  rule: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  errorCode?: string;
  /**
   * 结构化错误明细
   * @description 校验类 400 会带上每条问题的 path / rule。丢掉它就只剩
   * 「FlowDefinition 校验失败」这种无法定位的文案，用户不知道该改哪个节点。
   */
  details: ApiErrorDetail[];
  constructor(
    status: number,
    message: string,
    details: ApiErrorDetail[] = [],
    errorCode?: string,
  ) {
    super(message);
    this.status = status;
    this.details = details;
    this.errorCode = errorCode;
    this.name = "ApiError";
  }
}

/**
 * 读取响应里的结构化错误明细
 * @param payload 响应信封
 * @returns 形状符合的明细数组；没有则为空数组
 */
function readErrorDetails(payload: unknown): ApiErrorDetail[] {
  const candidate = (payload as { errors?: unknown } | undefined)?.errors;
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter(
    (item): item is ApiErrorDetail =>
      typeof (item as ApiErrorDetail | null)?.path === "string" &&
      typeof (item as ApiErrorDetail).rule === "string" &&
      typeof (item as ApiErrorDetail).message === "string",
  );
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** 跳过鉴权头（登录/刷新用） */
  skipAuth?: boolean;
  /** 跳过 401 自动刷新（刷新请求自身用，避免递归） */
  skipRefresh?: boolean;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(`${API_BASE_URL}/api${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

/** 401 时用 refreshToken 换新令牌；失败则清凭证并跳登录 */
async function tryRefresh(): Promise<boolean> {
  const refreshToken = authStorage.getRefreshToken();
  if (!refreshToken) return false;
  try {
    const refreshed = await request<AuthResponse>("/auth/refresh", {
      method: "POST",
      body: { refreshToken },
      skipAuth: true,
      skipRefresh: true,
    });
    authStorage.updateTokens(refreshed.token, refreshed.refreshToken);
    return true;
  } catch {
    return false;
  }
}

/**
 * 统一请求：拼 /api 前缀、注入 bearer、解 {code,data,message} 信封、
 * 401 自动刷新重试一次、失败清凭证跳登录、非 2xx 抛 ApiError（带 message）。
 */
export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, query, skipAuth, skipRefresh } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (!skipAuth) {
    const token = authStorage.getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const response = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && !skipRefresh && !skipAuth) {
    const ok = await tryRefresh();
    if (ok) {
      return request<T>(path, { ...options, skipRefresh: true });
    }
    authStorage.clear();
    if (
      typeof window !== "undefined" &&
      !window.location.pathname.startsWith("/login")
    ) {
      window.location.href = "/login";
    }
    throw new ApiError(401, "登录已过期，请重新登录");
  }

  let payload: Envelope<T> | undefined;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.message ?? `请求失败（${response.status}）`,
      readErrorDetails(payload),
      (payload as { errorCode?: string } | undefined)?.errorCode,
    );
  }

  // 成功：解信封返回 data
  return (payload?.data ?? (payload as unknown)) as T;
}
