import { api } from "./generated";
import { authControllerBindWechat } from "./generated/client";

export async function loginByWechat(code: string): Promise<LoginResult> {
  return (await api.wechatLogin({ code })) as LoginResult;
}

export async function loginByPhone(
  phone: string,
  password: string,
): Promise<LoginResult> {
  return (await api.phoneLogin({ phone, password })) as LoginResult;
}

export async function bindWechat(code: string): Promise<LoginResult> {
  return (await authControllerBindWechat({ code })) as LoginResult;
}

export async function getUserProfile(): Promise<User> {
  return (await api.getProfile()) as User;
}
