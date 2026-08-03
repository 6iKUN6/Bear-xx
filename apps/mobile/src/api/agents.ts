import { taroRequest } from "./mutator/taroRequest";

/** 智能体精简信息（后端 AgentResponseDto 的子集，仅取选择器所需字段） */
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  /** 头像 URL；null = 用内置默认头像 */
  avatar: string | null;
  enabled: boolean;
  isDefault: boolean;
}

/**
 * 获取智能体列表
 * @returns 返回智能体列表（后端已按 isDefault、创建时间排序）
 * @description 走带鉴权的 taroRequest；apiClient 会自动解 { code, data } 信封。
 */
export function getAgents(): Promise<AgentSummary[]> {
  return taroRequest<AgentSummary[]>("/api/agents", { method: "GET" });
}
