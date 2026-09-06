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
  errorCode?: string;
}

/**
 * 带 HTTP 状态码的请求错误
 * @description 调用方需要区分「服务端明确拒绝」和「网络没通」时才有得判断——
 * 只抛裸 Error 会把状态码丢掉，调用方只能把两者当成同一种失败处理。
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
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
        throw new ApiRequestError(
          message,
          response.statusCode,
          response.data?.errorCode,
        );
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
        throw new ApiRequestError(message, response.statusCode);
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
    let abortFetchStream: (() => void) | null = null;

    void this.applyRequestInterceptor(options)
      .then((resolvedOptions) => {
        if (state.aborted) {
          return;
        }

        if (this.shouldUseFetchStream()) {
          const controller = new AbortController();
          abortFetchStream = () => controller.abort();
          void this.consumeFetchStream(
            state,
            resolvedOptions,
            options,
            handlers,
            controller,
          );
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
          // 小程序 request 默认 60s 超时会掐断长任务的 SSE（生图等工具一跑
          // 就是分钟级）；放宽到 300s，与后端任务缓冲窗口对齐
          timeout: 300000,
          header: this.buildHeaders(
            resolvedOptions.header,
            resolvedOptions.skipAuth,
            { Accept: "text/event-stream" },
          ),
          success: () => {
            // 中止的连接不再冲刷残余缓冲、不触发 onDone：否则会把最后一个
            // 事件派发进已被新连接接管的 lifecycle，并误清新连接的 handle。
            if (state.aborted) {
              return;
            }

            this.flushSseBuffer(state, options, handlers);
            this.finishStream(state, handlers);
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
        // 同时置 finished，让 finishStream 的幂等闸门再拦一道（onDone 不应再触发）
        state.finished = true;
        requestTask?.abort();
        abortFetchStream?.();
      },
    };
  }

  private shouldUseFetchStream() {
    return Taro.getEnv() === Taro.ENV_TYPE.WEB && typeof fetch === "function";
  }

  private async consumeFetchStream<TData, TBody>(
    state: { buffer: string; finished: boolean; aborted: boolean },
    resolvedOptions: ApiRequestOptions<TBody>,
    options: ApiStreamOptions<TData, TBody>,
    handlers: StreamHandlers<TData>,
    controller: AbortController,
  ) {
    try {
      handlers.onOpen?.();

      const response = await fetch(
        this.buildUrl(
          resolvedOptions.url,
          resolvedOptions.pathParams,
          resolvedOptions.query,
        ),
        {
          method: resolvedOptions.method || "GET",
          body:
            resolvedOptions.data === undefined
              ? undefined
              : JSON.stringify(resolvedOptions.data),
          headers: this.buildHeaders(
            resolvedOptions.header,
            resolvedOptions.skipAuth,
            { Accept: "text/event-stream" },
          ),
          signal: controller.signal,
        },
      );

      if (response.status === 401) {
        this.handleUnauthorized();
        throw new Error("未授权，请重新登录");
      }

      if (!response.ok) {
        throw new ApiRequestError(
          await this.getFetchErrorMessage(response),
          response.status,
        );
      }

      if (!response.body) {
        state.buffer += (await response.text()).replace(/\r\n/g, "\n");
        this.flushSseBuffer(state, options, handlers);
        this.finishStream(state, handlers);
        return;
      }

      const reader = response.body.getReader();
      while (!state.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (value) {
          state.buffer += this.uint8ArrayToString(value).replace(/\r\n/g, "\n");
          this.consumeSseBuffer(state, options, handlers);
        }
      }

      if (!state.aborted) {
        this.flushSseBuffer(state, options, handlers);
        this.finishStream(state, handlers);
      }
    } catch (error) {
      if (state.aborted || this.isAbortError(error)) {
        return;
      }

      handlers.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
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
    return `${this.withBaseUrl(resolvedPath)}${queryString}`;
  }

  private withBaseUrl(url: string) {
    if (/^https?:\/\//i.test(url) || !API_BASE_URL) {
      return url;
    }

    return `${API_BASE_URL}${url.startsWith("/") ? url : `/${url}`}`;
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
    storage.remove(STORAGE_KEYS.AGENTS);
    storage.remove(STORAGE_KEYS.SELECTED_AGENT_ID);
    storage.remove(STORAGE_KEYS.AGENT_MODEL_SELECTIONS);
    Taro.redirectTo({ url: "/pages/login/index" });
  }

  private consumeSseBuffer<TData>(
    state: { buffer: string; finished: boolean; aborted: boolean },
    options: ApiStreamOptions<TData>,
    handlers: StreamHandlers<TData>,
  ) {
    // 已中止的连接不再派发事件：小程序 requestTask.abort() 不保证已到达
    // 但未派发的 chunk 停止回调，漏派发会与新连接的帧叠加造成重复渲染。
    if (state.aborted) {
      return;
    }

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
    state: { buffer: string; finished: boolean; aborted: boolean },
    options: ApiStreamOptions<TData>,
    handlers: StreamHandlers<TData>,
  ) {
    if (state.aborted) {
      return;
    }

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

  private finishStream(
    state: { finished: boolean },
    handlers: StreamHandlers<unknown>,
  ) {
    if (state.finished) {
      return;
    }

    state.finished = true;
    handlers.onDone?.();
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
    return this.uint8ArrayToString(new Uint8Array(buffer));
  }

  private uint8ArrayToString(uint8Array: Uint8Array) {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(uint8Array);
    }

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

  private async getFetchErrorMessage(response: Response) {
    try {
      const data = (await response.json()) as Partial<ApiResponseEnvelope<unknown>>;
      return data.message || "流式请求失败";
    } catch {
      return "流式请求失败";
    }
  }

  private isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
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
