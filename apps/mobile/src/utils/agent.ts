import defaultAgentAvatar from "@litter-bear/assets/agents/default-avatar.png";
import type { AgentSummary } from "../api/agents";

/** 默认助手的兜底显示名（取不到默认 agent 配置时使用） */
export const FALLBACK_AGENT_NAME = "办伴";

/** 头像地址；空值回退内置默认头像 */
export function agentAvatarSrc(avatar?: string | null): string {
  return avatar?.trim() ? avatar : (defaultAgentAvatar as string);
}

/** 按 id 找 agent；id 为空返回默认 agent */
export function findAgent(
  agents: AgentSummary[],
  agentId?: string | null,
): AgentSummary | undefined {
  if (agentId) {
    return agents.find((agent) => agent.id === agentId);
  }
  return agents.find((agent) => agent.isDefault);
}

/** 当前生效的智能体显示名：具体 agent → 其名；null → 默认 agent 名；兜底文案 */
export function resolveAgentName(
  agents: AgentSummary[],
  agentId?: string | null,
): string {
  return findAgent(agents, agentId)?.name ?? FALLBACK_AGENT_NAME;
}

/** 工具组 → 通讯录卡片能力标签（未登记的组回退原名） */
const TOOL_GROUP_LABELS: Record<string, string> = {
  default: "通用工具",
  weather: "天气",
  search: "联网搜索",
  "image-gen": "AI 生图",
  "mcd-order": "麦当劳点餐",
};

export function toolGroupLabel(group: string): string {
  return TOOL_GROUP_LABELS[group] ?? group;
}
