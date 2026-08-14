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
  agentName: string;
  agentAvatar: string | null;
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
  agentName: string;
  agentAvatar: string | null;
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
  detail: string | null;
  toolName: string | null;
  parentId: string | null;
  depth: number;
  nodeKey: string | null;
  mcpServer: string | null;
  mcpTool: string | null;
  inputSummary: Record<string, unknown> | null;
  outputSummary: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  durationMs: number | null;
  sequence: number;
}

export interface TaskDetail extends TaskSummary {
  trace: TaskTraceItem[];
}

// ---- Admin 测试会话 ----

export interface TestSession {
  id: string;
  title: string;
  lastMessage: string;
  messageCount: number;
  updatedAt: number;
}

export interface TestSessionMessage {
  id: string;
  role: string;
  content: string;
  status: string;
  createdAt: number;
  trace: TaskTraceItem[];
}

export interface TestSessionDetail {
  id: string;
  title: string;
  updatedAt: number;
  messages: TestSessionMessage[];
}

// ---- 对象存储 ----

export interface UploadCredential {
  token: string;
  key: string;
  uploadUrl: string;
  accessUrl: string;
  expiresAt: number;
}

export interface StorageAsset {
  id: string;
  key: string;
  url: string;
  kind: "IMAGE" | "AUDIO";
  usage: string;
  mimeType: string | null;
  size: number | null;
  status: "ACTIVE" | "BROKEN" | "DELETED";
  createdAt: number;
}

// ---- Agent CRUD ----

/** 能力闭集：工具组 → 工具（来自 GET /admin/capabilities） */
export interface CapabilityTool {
  name: string;
  description: string;
  requiresApproval: boolean;
}

export interface ToolGroup {
  name: string;
  tools: CapabilityTool[];
}

export interface AgentCapabilities {
  toolGroups: ToolGroup[];
}

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
  avatar: string | null;
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

export interface ModelPreset {
  id: string;
  presetId: string;
  name: string;
  description: string;
  provider: string;
  platform: string;
  model: string;
  baseURL: string | null;
  temperature: number | null;
  maxOutputTokens: number | null;
  topP: number | null;
  enabled: boolean;
  isDefault: boolean;
  apiKeyConfigured: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ModelPresetInput {
  presetId: string;
  name: string;
  description?: string;
  provider: string;
  platform: string;
  model: string;
  baseURL?: string | null;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  topP?: number | null;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface AgentInput {
  name: string;
  description?: string;
  avatar?: string | null;
  systemPrompt?: string | null;
  modelPreset?: string | null;
  defaultStrategy?: AgentStrategy;
  allowedStrategies?: AgentStrategy[];
  toolGroups?: string[];
  skills?: string[];
  maxSteps?: number | null;
  enabled?: boolean;
}
