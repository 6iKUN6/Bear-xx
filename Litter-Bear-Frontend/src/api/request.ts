import Taro from "@tarojs/taro";
import { API_BASE_URL } from "../utils/constants";
import * as storage from "../utils/storage";
import { STORAGE_KEYS } from "../utils/constants";

interface RequestOptions {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  data?: unknown;
  header?: Record<string, string>;
}

interface ApiResponse<T> {
  code: number;
  data: T;
  message: string;
}

export async function request<T>(options: RequestOptions): Promise<T> {
  const token = storage.get<string>(STORAGE_KEYS.TOKEN);

  const header: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.header,
  };

  if (token) {
    header["Authorization"] = `Bearer ${token}`;
  }

  try {
    const response = await Taro.request({
      url: `${API_BASE_URL}${options.url}`,
      method: options.method || "GET",
      data: options.data,
      header,
    });

    if (response.statusCode === 401) {
      storage.remove(STORAGE_KEYS.TOKEN);
      storage.remove(STORAGE_KEYS.USER_INFO);
      Taro.redirectTo({ url: "/pages/login/index" });
      return Promise.reject(new Error("未授权，请重新登录"));
    }

    if (response.statusCode !== 200) {
      const msg = (response.data as ApiResponse<unknown>)?.message || "请求失败";
      Taro.showToast({ title: msg, icon: "none" });
      return Promise.reject(new Error(msg));
    }

    const body = response.data as ApiResponse<T>;
    return body.data;
  } catch (err) {
    Taro.showToast({ title: "网络异常", icon: "none" });
    return Promise.reject(err);
  }
}

export function get<T>(url: string, data?: unknown): Promise<T> {
  return request<T>({ url, method: "GET", data });
}

export function post<T>(url: string, data?: unknown): Promise<T> {
  return request<T>({ url, method: "POST", data });
}
