import { taroRequest } from "./mutator/taroRequest";

/** 智能体精简信息（后端 AgentResponseDto 的子集，仅取选择器所需字段） */
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  /** 头像 URL；null = 显示名称首字 */
  avatar: string | null;
  /** 工具组，仅供「智能体」页卡片上的能力标签展示；由后端从绑定 Flow 的图上推导 */
  toolGroups: string[];
  enabled: boolean;
  visible: boolean;
  minimumMembershipTier: "FREE" | "PLUS" | "PRO";
  canUse: boolean;
  accessReason: "DISABLED" | "MEMBERSHIP_EXPIRED" | "MEMBERSHIP_REQUIRED" | null;
  requiredTier: "PLUS" | "PRO" | null;
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
