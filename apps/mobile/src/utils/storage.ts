import Taro from "@tarojs/taro";

export function get<T>(key: string): T | null {
  try {
    const value = Taro.getStorageSync(key);
    return value ? (value as T) : null;
  } catch {
    return null;
  }
}

export function set(key: string, data: unknown): void {
  try {
    Taro.setStorageSync(key, data);
  } catch (e) {
    console.error("Storage set error:", e);
  }
}

export function remove(key: string): void {
  try {
    Taro.removeStorageSync(key);
  } catch (e) {
    console.error("Storage remove error:", e);
  }
}
