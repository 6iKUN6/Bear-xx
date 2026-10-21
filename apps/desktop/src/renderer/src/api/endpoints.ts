import { request } from "./client";
import type {
  AccountLoginInput,
  Agent,
  AgentModelOptions,
  AuthResponse,
  ConversationMessagePage,
  ConversationSummary,
  StreamTaskStatus,
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

/** 获取当前用户的会话目录（按更新时间倒序，不含消息） */
export function getConversations(): Promise<ConversationSummary[]> {
  return request<ConversationSummary[]>("/conversations");
}

/** 分页读取会话消息：before 缺省取最新一页，否则取早于该消息的一页 */
export function getConversationMessages(
  conversationId: string,
  before?: string,
): Promise<ConversationMessagePage> {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  return request<ConversationMessagePage>(
    `/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
  );
}

/** 查询任务状态：判断能否续接，已结束时取终稿 */
export function getStreamTaskStatus(taskId: string): Promise<StreamTaskStatus> {
  return request<StreamTaskStatus>(
    `/stream-tasks/${encodeURIComponent(taskId)}`,
  );
}

/** 获取智能体列表（供选择器；含 canUse 标记，会员不可用的置灰展示） */
export function getAgents(): Promise<Agent[]> {
  return request<Agent[]>("/agents");
}

/** 获取指定智能体允许终端选择的模型（含思考能力目录）；自定义 Flow Agent 返回空 models */
export function getAgentModelOptions(
  agentId: string,
): Promise<AgentModelOptions> {
  return request<AgentModelOptions>(`/agents/${agentId}/models`);
}

export function cancelStreamTask(
  taskId: string,
): Promise<{ taskId: string; status: string }> {
  return request(`/stream-tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
  });
}
