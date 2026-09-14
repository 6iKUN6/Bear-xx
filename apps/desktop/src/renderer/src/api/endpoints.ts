import { request } from "./client";
import type {
  AccountLoginInput,
  Agent,
  AgentModelOptions,
  AuthResponse,
  Conversation,
} from "./types";

/**
 * 账号密码登录（C 端）。
 * 注意后端语义：账号不存在时会用当前密码自动注册并直接登录。
 */
export function loginAccount(input: AccountLoginInput): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/account/login", {
    method: "POST",
    body: input,
    skipAuth: true,
    skipRefresh: true,
  });
}

/** 登出：把当前 Access Token 加入服务端黑名单 */
export function logoutAccount(): Promise<{ success: boolean }> {
  return request<{ success: boolean }>("/auth/logout", { method: "POST" });
}

/** 获取当前用户的全部会话（含消息列表），按服务端返回顺序 */
export function getConversations(): Promise<Conversation[]> {
  return request<Conversation[]>("/conversations");
}

/** 获取智能体列表（供选择器；含 canUse 标记，会员不可用的置灰展示） */
export function getAgents(): Promise<Agent[]> {
  return request<Agent[]>("/agents");
}

/** 获取指定智能体允许终端选择的模型（含思考能力目录）；自定义 Flow Agent 返回空 models */
export function getAgentModelOptions(agentId: string): Promise<AgentModelOptions> {
  return request<AgentModelOptions>(`/agents/${agentId}/models`);
}
