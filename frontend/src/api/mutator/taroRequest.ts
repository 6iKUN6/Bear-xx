import { apiClient } from "../request";

export function taroRequest<TResponse>(
  url: string,
  options: RequestInit = {},
): Promise<TResponse> {
  return apiClient.request<TResponse, unknown>({
    url,
    method: (options.method || "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    data: parseBody(options.body),
    header: normalizeHeaders(options.headers),
  });
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function normalizeHeaders(headers: HeadersInit | undefined) {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, string>>((result, [key, value]) => {
      result[key] = value;
      return result;
    }, {});
  }

  return headers;
}
