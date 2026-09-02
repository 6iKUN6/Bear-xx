import { USE_MOCK } from "../utils/constants";
import { api } from "./generated";
import { authControllerBindWechat } from "./generated/client";

function buildMockLoginResult(): LoginResult {
  return {
    token: "mock_token_" + Date.now(),
    refreshToken: "mock_refresh_token_" + Date.now(),
    user: {
      id: "user_001",
      nickname: "小熊用户",
      avatarUrl: "https://img.yzcdn.cn/vant/cat.jpeg",
      membershipTier: "FREE",
      effectiveMembershipTier: "FREE",
      membershipExpiresAt: null,
      membershipExpired: false,
    },
  };
}

export async function loginByWechat(code: string): Promise<LoginResult> {
  if (USE_MOCK) {
    return buildMockLoginResult();
  }

  return (await api.wechatLogin({ code })) as LoginResult;
}

export async function loginByPhone(
  phone: string,
  password: string,
): Promise<LoginResult> {
  if (USE_MOCK) {
    return buildMockLoginResult();
  }

  return (await api.phoneLogin({ phone, password })) as LoginResult;
}

export async function bindWechat(code: string): Promise<LoginResult> {
  if (USE_MOCK) {
    return buildMockLoginResult();
  }

  return (await authControllerBindWechat({ code })) as LoginResult;
}

export async function getUserProfile(): Promise<User> {
  if (USE_MOCK) {
    return {
      id: "user_001",
      nickname: "小熊用户",
      avatarUrl: "https://img.yzcdn.cn/vant/cat.jpeg",
      membershipTier: "FREE",
      effectiveMembershipTier: "FREE",
      membershipExpiresAt: null,
      membershipExpired: false,
    };
  }

  return (await api.getProfile()) as User;
}
