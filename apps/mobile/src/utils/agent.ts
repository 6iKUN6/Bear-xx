interface AgentIdentity {
  id: string;
  name: string;
  isDefault: boolean;
}

export type ChatAgentSelectionMode = "single" | "group" | "flex";

/** 默认助手的兜底显示名（取不到默认 agent 配置时使用） */
export const FALLBACK_AGENT_NAME = "办伴";

/** 头像地址；空值由头像组件回退为智能体名称首字。 */
export function agentAvatarSrc(avatar?: string | null): string | null {
  return avatar?.trim() || null;
}

/** 智能体头像回退文字：名称去空格后的首个 Unicode 字符。 */
export function agentInitial(name?: string | null): string {
  return Array.from(name?.trim() ?? "")[0] ?? "?";
}

/** 按 id 找 agent；id 为空返回默认 agent */
export function findAgent<T extends AgentIdentity>(
  agents: T[],
  agentId?: string | null,
): T | undefined {
  if (agentId) {
    return agents.find((agent) => agent.id === agentId);
  }
  return agents.find((agent) => agent.isDefault);
}

/** 当前生效的智能体显示名：具体 agent → 其名；null → 默认 agent 名；兜底文案 */
export function resolveAgentName<T extends AgentIdentity>(
  agents: T[],
  agentId?: string | null,
): string {
  return findAgent(agents, agentId)?.name ?? FALLBACK_AGENT_NAME;
}

/** 解析本条消息的指定智能体；@ 提及始终优先且保留真实 id。 */
export function resolveOutgoingAgentId(
  mode: ChatAgentSelectionMode,
  mentionAgentId?: string,
  selectedAgentId?: string | null,
): string | undefined {
  if (mode === "single") {
    return undefined;
  }

  if (mentionAgentId) {
    return mentionAgentId;
  }

  return mode === "flex" ? (selectedAgentId ?? undefined) : undefined;
}

type UnassignedAssistantNotice = "routing" | "failure" | null;

/** 群聊无身份消息的占位提示；路由中状态优先于失败判断。 */
export function getUnassignedAssistantNotice(
  status: string,
  isGroupConversation: boolean,
  hasExplicitIdentity: boolean,
  routing: boolean,
  hasCreatedTask: boolean,
): UnassignedAssistantNotice {
  if (!hasExplicitIdentity && routing) {
    return "routing";
  }

  if (
    status === "error" &&
    isGroupConversation &&
    !hasExplicitIdentity &&
    !hasCreatedTask
  ) {
    return "failure";
  }

  return null;
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
