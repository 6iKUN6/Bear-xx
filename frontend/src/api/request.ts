import Taro from "@tarojs/taro";
import { API_BASE_URL, STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";

export type ApiRequestMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export interface ApiResponseEnvelope<T> {
  code: number;
  data: T;
  message: string;
}

export interface ApiRequestOptions<TData = unknown> {
  url: string;
  method?: ApiRequestMethod;
  data?: TData;
  query?: Record<string, unknown>;
  pathParams?: Record<string, string | number>;
  header?: Record<string, string>;
  skipAuth?: boolean;
}

export interface ApiUploadOptions<TFormData = Record<string, unknown>> {
  url: string;
  method?: ApiRequestMethod;
  filePath: string;
  name: string;
  formData?: TFormData;
  query?: Record<string, unknown>;
  pathParams?: Record<string, string | number>;
  header?: Record<string, string>;
  skipAuth?: boolean;
}

export interface StreamEvent<TData = unknown> {
  id?: string;
  event?: string;
  data: TData;
  rawData: string;
}

export interface StreamHandlers<TData = unknown> {
  onOpen?: () => void;
  onMessage?: (event: StreamEvent<TData>) => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
}

export interface ApiStreamOptions<TData = unknown, TBody = unknown>
  extends ApiRequestOptions<TBody> {
  parseEventData?: (rawData: string, rawEvent: StreamEvent<string>) => TData;
}

export interface StreamRequestHandle {
  abort: () => void;
}

type MaybePromise<T> = T | Promise<T>;

export type RequestInterceptor = (
  options: ApiRequestOptions,
) => MaybePromise<ApiRequestOptions>;

export type ResponseInterceptor = <T>(
  response: ApiResponseEnvelope<T>,
) => MaybePromise<ApiResponseEnvelope<T>>;

export class BaseApiClient {
  private requestInterceptor?: RequestInterceptor;
  private responseInterceptor?: ResponseInterceptor;

  setRequestInterceptor(interceptor?: RequestInterceptor) {
    this.requestInterceptor = interceptor;
  }

  setResponseInterceptor(interceptor?: ResponseInterceptor) {
    this.responseInterceptor = interceptor;
  }

  async request<TResponse, TData = unknown>(
    options: ApiRequestOptions<TData>,
  ): Promise<TResponse> {
    try {
      const resolvedOptions = await this.applyRequestInterceptor(options);
      const response = await Taro.request<ApiResponseEnvelope<TResponse>>({
        url: this.buildUrl(
          resolvedOptions.url,
          resolvedOptions.pathParams,
          resolvedOptions.query,
        ),
        method: resolvedOptions.method || "GET",
        data: resolvedOptions.data,
        header: this.buildHeaders(
          resolvedOptions.header,
          resolvedOptions.skipAuth,
        ),
      });

      if (response.statusCode === 401) {
        this.handleUnauthorized();
        throw new Error("未授权，请重新登录");
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const message = response.data?.message || "请求失败";
        Taro.showToast({ title: message, icon: "none" });
        throw new Error(message);
      }

      const envelope = await this.applyResponseInterceptor(response.data);
      return envelope.data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }

      Taro.showToast({ title: "网络异常", icon: "none" });
      throw error;
    }
  }

  async upload<TResponse, TFormData = Record<string, unknown>>(
    options: ApiUploadOptions<TFormData>,
  ): Promise<TResponse> {
    try {
      const requestLikeOptions: ApiRequestOptions<TFormData> = {
        url: options.url,
        method: options.method || "POST",
        data: options.formData,
        query: options.query,
        pathParams: options.pathParams,
        header: options.header,
        skipAuth: options.skipAuth,
      };
      const resolvedOptions =
        await this.applyRequestInterceptor(requestLikeOptions);

      const response = await Taro.uploadFile({
        url: this.buildUrl(
          resolvedOptions.url,
          resolvedOptions.pathParams,
          resolvedOptions.query,
        ),
        filePath: options.filePath,
        name: options.name,
        formData: resolvedOptions.data as Record<string, unknown> | undefined,
        header: this.buildHeaders(
          resolvedOptions.header,
          resolvedOptions.skipAuth,
          undefined,
          false,
        ),
      });

      if (response.statusCode === 401) {
        this.handleUnauthorized();
        throw new Error("未授权，请重新登录");
      }

      const envelope = this.parseUploadResponse<TResponse>(response.data);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const message = envelope?.message || "上传失败";
        Taro.showToast({ title: message, icon: "none" });
        throw new Error(message);
      }

      const resolvedEnvelope = await this.applyResponseInterceptor(envelope);
      return resolvedEnvelope.data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }

      Taro.showToast({ title: "上传失败", icon: "none" });
      throw error;
    }
  }

  stream<TData = unknown, TBody = unknown>(
    options: ApiStreamOptions<TData, TBody>,
    handlers: StreamHandlers<TData> = {},
  ): StreamRequestHandle {
    const state = {
      buffer: "",
      finished: false,
      aborted: false,
    };

    let requestTask:
      | ReturnType<typeof Taro.request>
      | null = null;

    void this.applyRequestInterceptor(options)
      .then((resolvedOptions) => {
        if (state.aborted) {
          return;
        }

        requestTask = Taro.request({
          url: this.buildUrl(
            resolvedOptions.url,
            resolvedOptions.pathParams,
            resolvedOptions.query,
          ),
          method: resolvedOptions.method || "GET",
          data: resolvedOptions.data,
          enableChunked: true,
          header: this.buildHeaders(
            resolvedOptions.header,
            resolvedOptions.skipAuth,
            { Accept: "text/event-stream" },
          ),
          success: () => {
            this.flushSseBuffer(state, options, handlers);
            if (!state.finished) {
              state.finished = true;
              handlers.onDone?.();
            }
          },
          fail: (error) => {
            if (state.aborted) {
              return;
            }
            handlers.onError?.(new Error(error.errMsg || "流式请求失败"));
          },
        });

        handlers.onOpen?.();

        requestTask.onChunkReceived?.((result) => {
          const chunkText = this.arrayBufferToString(result.data as ArrayBuffer);
          state.buffer += chunkText.replace(/\r\n/g, "\n");
          this.consumeSseBuffer(state, options, handlers);
        });

        if (state.aborted) {
          requestTask.abort();
        }
      })
      .catch((error) => {
        if (state.aborted) {
          return;
        }
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

    return {
      abort: () => {
        state.aborted = true;
        requestTask?.abort();
      },
    };
  }

  private async applyRequestInterceptor<TData>(
    options: ApiRequestOptions<TData>,
  ): Promise<ApiRequestOptions<TData>> {
    if (!this.requestInterceptor) {
      return options;
    }

    return (await this.requestInterceptor(options)) as ApiRequestOptions<TData>;
  }

  private async applyResponseInterceptor<T>(
    response: ApiResponseEnvelope<T>,
  ): Promise<ApiResponseEnvelope<T>> {
    if (!this.responseInterceptor) {
      return response;
    }

    return await this.responseInterceptor(response);
  }

  private parseUploadResponse<T>(
    rawData: string,
  ): ApiResponseEnvelope<T> {
    try {
      return JSON.parse(rawData) as ApiResponseEnvelope<T>;
    } catch {
      return {
        code: 500,
        data: null as T,
        message: "上传响应解析失败",
      };
    }
  }

  private buildHeaders(
    customHeader?: Record<string, string>,
    skipAuth?: boolean,
    extraHeader?: Record<string, string>,
    useJsonContentType = true,
  ) {
    const headers: Record<string, string> = {};

    if (useJsonContentType) {
      headers["Content-Type"] = "application/json";
    }

    Object.assign(headers, extraHeader, customHeader);
    const token = storage.get<string>(STORAGE_KEYS.TOKEN);

    if (!skipAuth && token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }

  private buildUrl(
    url: string,
    pathParams?: Record<string, string | number>,
    query?: Record<string, unknown>,
  ) {
    const resolvedPath = this.interpolatePath(url, pathParams);
    const queryString = this.stringifyQuery(query);
    return `${API_BASE_URL}${resolvedPath}${queryString}`;
  }

  private interpolatePath(
    url: string,
    pathParams?: Record<string, string | number>,
  ) {
    if (!pathParams) {
      return url;
    }

    return Object.entries(pathParams).reduce((result, [key, value]) => {
      const encodedValue = encodeURIComponent(String(value));
      return result
        .replace(new RegExp(`:${key}(?=/|$)`, "g"), encodedValue)
        .replace(new RegExp(`\\{${key}\\}`, "g"), encodedValue);
    }, url);
  }

  private stringifyQuery(query?: Record<string, unknown>) {
    if (!query) {
      return "";
    }

    const parts: string[] = [];
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null) {
            continue;
          }
          parts.push(
            `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`,
          );
        }
        continue;
      }

      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
      );
    }

    return parts.length > 0 ? `?${parts.join("&")}` : "";
  }

  private handleUnauthorized() {
    storage.remove(STORAGE_KEYS.TOKEN);
    storage.remove(STORAGE_KEYS.USER_INFO);
    Taro.redirectTo({ url: "/pages/login/index" });
  }

  private consumeSseBuffer<TData>(
    state: { buffer: string; finished: boolean },
    options: ApiStreamOptions<TData>,
    handlers: StreamHandlers<TData>,
  ) {
    let separatorIndex = state.buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const rawBlock = state.buffer.slice(0, separatorIndex).trim();
      state.buffer = state.buffer.slice(separatorIndex + 2);

      if (rawBlock) {
        const event = this.parseSseEvent(rawBlock, options.parseEventData);
        if (event) {
          handlers.onMessage?.(event);
        }
      }

      separatorIndex = state.buffer.indexOf("\n\n");
    }
  }

  private flushSseBuffer<TData>(
    state: { buffer: string; finished: boolean },
    options: ApiStreamOptions<TData>,
    handlers: StreamHandlers<TData>,
  ) {
    const rawBlock = state.buffer.trim();
    if (!rawBlock) {
      return;
    }

    const event = this.parseSseEvent(rawBlock, options.parseEventData);
    if (event) {
      handlers.onMessage?.(event);
    }
    state.buffer = "";
  }

  private parseSseEvent<TData>(
    rawBlock: string,
    parseEventData?: (rawData: string, rawEvent: StreamEvent<string>) => TData,
  ): StreamEvent<TData> | null {
    const lines = rawBlock.split("\n");
    let id: string | undefined;
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(":")) {
        continue;
      }

      const separatorIndex = line.indexOf(":");
      const field =
        separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
      const value =
        separatorIndex >= 0
          ? line.slice(separatorIndex + 1).replace(/^\s+/, "")
          : "";

      if (field === "id") {
        id = value;
        continue;
      }

      if (field === "event") {
        event = value;
        continue;
      }

      if (field === "data") {
        dataLines.push(value);
      }
    }

    if (dataLines.length === 0) {
      return null;
    }

    const rawData = dataLines.join("\n");
    const rawEvent: StreamEvent<string> = {
      id,
      event,
      data: rawData,
      rawData,
    };

    return {
      id,
      event,
      rawData,
      data: parseEventData
        ? parseEventData(rawData, rawEvent)
        : (this.tryParseJson(rawData) as TData),
    };
  }

  private tryParseJson(rawData: string): unknown {
    try {
      return JSON.parse(rawData) as unknown;
    } catch {
      return rawData;
    }
  }

  private arrayBufferToString(buffer: ArrayBuffer) {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(buffer);
    }

    const uint8Array = new Uint8Array(buffer);
    let result = "";
    for (let index = 0; index < uint8Array.length; index++) {
      result += String.fromCharCode(uint8Array[index]);
    }

    try {
      return decodeURIComponent(escape(result));
    } catch {
      return result;
    }
  }
}

export const apiClient = new BaseApiClient();

export async function request<TResponse, TData = unknown>(
  options: ApiRequestOptions<TData>,
) {
  return apiClient.request<TResponse, TData>(options);
}

export async function upload<TResponse, TFormData = Record<string, unknown>>(
  options: ApiUploadOptions<TFormData>,
) {
  return apiClient.upload<TResponse, TFormData>(options);
}
