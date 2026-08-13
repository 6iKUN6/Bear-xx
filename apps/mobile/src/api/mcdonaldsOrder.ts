import Taro from "@tarojs/taro";
import {
  getMcDonaldsOrderControllerPaymentQrUrl,
  mcDonaldsOrderControllerDetail,
  mcDonaldsOrderControllerList,
  mcDonaldsOrderControllerPaymentLink,
  mcDonaldsOrderControllerRefresh,
} from "./generated/client";
import type {
  McDonaldsOrderPageDto,
  McDonaldsOrderResponseDto,
  McDonaldsPaymentLinkDto,
} from "./generated/models";
import { API_BASE_URL, STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";
import { ApiRequestError } from "./request";

export type McDonaldsOrder = McDonaldsOrderResponseDto;

/**
 * 获取当前用户的麦当劳订单分页列表
 * @param cursor 上一页最后一条订单的本地ID
 * @returns 返回安全订单卡片分页数据
 * @description 仅消费后端安全 DTO，不包含支付链接、密文或原始 MCP 响应。
 */
export function getMcDonaldsOrders(
  cursor?: string,
): Promise<McDonaldsOrderPageDto> {
  return mcDonaldsOrderControllerList(
    cursor ? { cursor } : undefined,
  );
}

/**
 * 获取一条订单的安全详情
 * @param id 本地订单ID
 * @returns 返回安全订单详情
 * @description 用于订单详情页重新加载最新卡片数据，不读取或缓存支付URL。
 */
export function getMcDonaldsOrder(id: string): Promise<McDonaldsOrder> {
  return mcDonaldsOrderControllerDetail(id);
}

/**
 * 手动刷新订单状态
 * @param id 本地订单ID
 * @returns 返回刷新后的安全订单详情
 * @description 用户显式操作才触发官方订单查询，客户端不做轮询。
 */
export function refreshMcDonaldsOrder(id: string): Promise<McDonaldsOrder> {
  return mcDonaldsOrderControllerRefresh(id);
}

/**
 * 临时获取官方支付链接
 * @param id 本地订单ID
 * @returns 返回只供当前跳转使用的支付链接与过期时间
 * @description 调用方必须立即消费链接，禁止写入 Zustand、本地存储或消息状态。
 */
export function getMcDonaldsPaymentLink(
  id: string,
): Promise<McDonaldsPaymentLinkDto> {
  return mcDonaldsOrderControllerPaymentLink(id);
}

/**
 * 获取受鉴权保护的支付二维码二进制数据
 * @param id 本地订单ID
 * @returns 返回二维码PNG的 ArrayBuffer
 * @description 小程序 Image 无法附带 Bearer Token，因此这里显式请求 arraybuffer，交由支付面板写入临时文件后展示。
 */
export async function getMcDonaldsPaymentQr(id: string): Promise<ArrayBuffer> {
  const token = storage.get<string>(STORAGE_KEYS.TOKEN);
  const response = await Taro.request<ArrayBuffer>({
    url: withApiBaseUrl(getMcDonaldsOrderControllerPaymentQrUrl(id)),
    method: "GET",
    responseType: "arraybuffer",
    header: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

  if (response.statusCode === 401) {
    storage.remove(STORAGE_KEYS.TOKEN);
    storage.remove(STORAGE_KEYS.USER_INFO);
    Taro.redirectTo({ url: "/pages/login/index" });
    throw new ApiRequestError("未授权，请重新登录", 401);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new ApiRequestError(readBinaryErrorMessage(response.data), response.statusCode);
  }

  return response.data;
}

function withApiBaseUrl(url: string): string {
  if (/^https?:\/\//i.test(url) || !API_BASE_URL) {
    return url;
  }

  return `${API_BASE_URL}${url.startsWith("/") ? url : `/${url}`}`;
}

function readBinaryErrorMessage(data: ArrayBuffer): string {
  try {
    const text = decodeArrayBuffer(data);
    const parsed = JSON.parse(text) as { message?: string };
    return parsed.message || "获取支付二维码失败";
  } catch {
    return "获取支付二维码失败";
  }
}

function decodeArrayBuffer(data: ArrayBuffer): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(data);
  }

  return String.fromCharCode(...new Uint8Array(data));
}
