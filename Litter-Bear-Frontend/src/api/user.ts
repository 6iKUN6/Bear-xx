import { USE_MOCK } from "../utils/constants";
import { post, get } from "./request";

export async function loginByWechat(code: string): Promise<LoginResult> {
  if (USE_MOCK) {
    return {
      token: "mock_token_" + Date.now(),
      user: {
        id: "user_001",
        nickname: "小熊用户",
        avatarUrl:
          "https://img.yzcdn.cn/vant/cat.jpeg",
      },
    };
  }
  return post<LoginResult>("/auth/wechat-login", { code });
}

export async function getUserProfile(): Promise<User> {
  if (USE_MOCK) {
    return {
      id: "user_001",
      nickname: "小熊用户",
      avatarUrl:
        "https://img.yzcdn.cn/vant/cat.jpeg",
    };
  }
  return get<User>("/user/profile");
}
