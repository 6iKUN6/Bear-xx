import {
  mcDonaldsCredentialControllerBind,
  mcDonaldsCredentialControllerGetActive,
  mcDonaldsCredentialControllerUnbind,
} from "./generated/client";
import type { McDonaldsCredentialResponseDto } from "./generated/models";

export type McDonaldsCredential = McDonaldsCredentialResponseDto;

/**
 * 获取当前用户的麦当劳 MCP Token 绑定状态
 * @returns 返回安全凭据摘要；未绑定时返回 null
 * @description 响应不包含 Token、密文或完整指纹，可直接用于设置页状态展示。
 */
export function getMcDonaldsCredential(): Promise<McDonaldsCredential | null> {
  return mcDonaldsCredentialControllerGetActive();
}

/**
 * 绑定当前用户提交的麦当劳 MCP Token
 * @param token 用户本次输入的 Token
 * @returns 返回绑定成功后的安全凭据摘要
 * @description Token 只作为本次请求体发送，调用方完成后必须清空页面输入状态，不能写入本地存储。
 */
export function bindMcDonaldsCredential(
  token: string,
): Promise<McDonaldsCredential> {
  return mcDonaldsCredentialControllerBind({ token });
}

/**
 * 解绑当前用户的麦当劳 MCP Token
 * @returns 无返回值
 * @description 解绑后历史订单仍可查看，但新下单、刷新状态和支付入口将被后端拒绝。
 */
export function unbindMcDonaldsCredential(): Promise<void> {
  return mcDonaldsCredentialControllerUnbind();
}
