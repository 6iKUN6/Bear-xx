import { USE_MOCK } from "../utils/constants";
import { api } from "./generated";

export async function loginByWechat(code: string): Promise<LoginResult> {
  if (USE_MOCK) {
    return {
      token: "mock_token_" + Date.now(),
      user: {
        id: "user_001",
        nickname: "小熊用户",
        avatarUrl: "https://img.yzcdn.cn/vant/cat.jpeg",
      },
    };
  }

  return (await api.wechatLogin({ code })) as LoginResult;
}

export async function getUserProfile(): Promise<User> {
  if (USE_MOCK) {
    return {
      id: "user_001",
      nickname: "小熊用户",
      avatarUrl: "https://img.yzcdn.cn/vant/cat.jpeg",
    };
  }

  return (await api.getProfile()) as User;
}
