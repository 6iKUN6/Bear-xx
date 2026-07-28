// 手写对齐后端 DTO 的响应类型（admin 只消费十几个端点，手写比 orval 更轻）。

export interface AuthUser {
  id: string;
  nickname: string;
  avatarUrl: string;
}

export interface AuthResponse {
  token: string;
  refreshToken: string;
  user: AuthUser;
}

export interface StatusCount {
  status: string;
  count: number;
}

export interface ObservabilityOverview {
  rangeDays: number;
  totalTasks: number;
  completedTasks: number;
  erroredTasks: number;
  successRate: number;
  avgDurationMs: number | null;
  statusBreakdown: StatusCount[];
}

export interface AgentUsage {
  agentId: string | null;
  taskCount: number;
  completedCount: number;
  successRate: number;
  avgDurationMs: number | null;
}

export interface ToolUsage {
  toolName: string | null;
  callCount: number;
  successCount: number;
  successRate: number;
  avgDurationMs: number | null;
}

export interface ErrorCategoryCount {
  category: string;
  count: number;
}

export interface TaskSummary {
  id: string;
  agentId: string | null;
  type: string;
  status: string;
  durationMs: number | null;
  totalTokens: number | null;
  toolCallCount: number | null;
  modelCallCount: number | null;
  errorMessage: string | null;
  createdAt: number;
}

export interface RecentTasks {
  items: TaskSummary[];
  nextCursor: string | null;
}

export interface TaskTraceItem {
  id: string;
  type: string;
  status: string;
  title: string;
  summary: string | null;
  toolName: string | null;
  durationMs: number | null;
  sequence: number;
}

export interface TaskDetail extends TaskSummary {
  trace: TaskTraceItem[];
}

// ---- Agent CRUD ----

export type AgentStrategy =
  | "AUTO"
  | "DIRECT"
  | "REACT"
  | "PLAN_EXECUTE"
  | "HYBRID";

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string | null;
  modelPreset: string | null;
  defaultStrategy: AgentStrategy;
  allowedStrategies: AgentStrategy[];
  toolGroups: string[];
  skills: string[];
  maxSteps: number | null;
  enabled: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentInput {
  name: string;
  description?: string;
  systemPrompt?: string | null;
  modelPreset?: string | null;
  defaultStrategy?: AgentStrategy;
  allowedStrategies?: AgentStrategy[];
  toolGroups?: string[];
  skills?: string[];
  maxSteps?: number | null;
  enabled?: boolean;
}
