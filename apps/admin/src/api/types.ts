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

export interface CosUploadCredential {
  key: string;
  uploadUrl: string;
  accessUrl: string;
  headers: Record<string, string>;
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

/** 可写进节点 modelPreset 的预设选项；与后端 listAvailableModels 同一闭集。 */
export interface ModelPresetOption {
  id: string;
  /** 底层模型名，仅用于界面区分同名预设 */
  model: string;
}

export interface AgentCapabilities {
  toolGroups: ToolGroup[];
  modelPresets: ModelPresetOption[];
}

/**
 * @deprecated Agent 上已不再有策略字段；保留供历史 trace 的 STRATEGY_DECISION 展示。
 */
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
  /** 绑定的已发布 FlowVersion；null = 执行内置的直接回复 Flow */
  defaultFlowVersionId: string | null;
  /** 可用工具组，仅供展示；执行用的工具由 Flow 节点声明 */
  toolGroups: string[];
  enabled: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 上游 wire 格式闭集；决定服务端用哪个 SDK，provider 由它推导 */
export type UpstreamFormat =
  | "openai_chat_completions"
  | "openai_responses"
  | "anthropic_messages";

/** 服务端探针实测出的能力档位；带工具的节点在发布校验时要求 tools */
export type ModelPresetCapability =
  | "unverified"
  | "unreachable"
  | "basic"
  | "tools";

export interface ModelPreset {
  id: string;
  presetId: string;
  name: string;
  description: string;
  upstreamFormat: UpstreamFormat;
  /** 由 upstreamFormat 推导，只读展示，不可单独设置 */
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
  /** 形如 `Key ...a1b2c3`，取自不可逆指纹尾部；密钥本身永不下发 */
  apiKeyHint: string | null;
  capability: ModelPresetCapability;
  lastCheckedAt: number | null;
  lastCheckError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ModelPresetInput {
  presetId: string;
  name: string;
  description?: string;
  upstreamFormat: UpstreamFormat;
  platform: string;
  model: string;
  baseURL?: string | null;
  /** 明文，仅写入方向提交；留空表示保持已存密钥不变 */
  apiKey?: string;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  topP?: number | null;
  enabled?: boolean;
  isDefault?: boolean;
}

/** 保存前试探连接的入参；不落库、不改任何预设的能力档位 */
export interface ModelPresetProbeInput {
  upstreamFormat: UpstreamFormat;
  platform: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
}

export interface ModelPresetProbeResult {
  capability: ModelPresetCapability;
  /** L1：能否建立连接并拿到一次回复 */
  reachable: boolean;
  /** L2：工具调用发起 + 结果回灌是否闭环 */
  toolRoundTrip: boolean;
  error: string | null;
}

/* ── AgentFlow 控制面 ────────────────────────────────────── */

export type AgentFlowVersionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

/** 校验错误；`path` 形如 `nodes.0.config.modelPreset`，用于在编辑器里定位 */
export interface FlowDefinitionValidationError {
  path: string;
  rule: string;
  message: string;
}

export interface AgentFlowVersion {
  id: string;
  flowId: string;
  version: number;
  status: AgentFlowVersionStatus;
  /** FlowDefinition JSON 工件；前端不解析其结构合法性，原样编辑与回传 */
  definition: object;
  /**
   * 该工件是否仍符合当前后端 Definition 契约
   * @description 契约升版后的存量工件会是 false。此时**不能**保存、校验或发布——服务端一定拒绝，
   * 让按钮可点等于让用户白点一次再收到 400。要改只能新建草稿。
   */
  schemaCompatible: boolean;
  /** 不兼容时的逐条原因；兼容时后端不下发此字段 */
  schemaErrors?: FlowDefinitionValidationError[];
  /** 布局无关摘要；草稿为 null，发布后固化 */
  digest: string | null;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  archivedAt: number | null;
}

export interface AgentFlow {
  id: string;
  name: string;
  description: string;
  publishedVersionId: string | null;
  createdAt: number;
  updatedAt: number;
  publishedVersion?: AgentFlowVersion | null;
  draftVersion?: AgentFlowVersion;
}

export interface AgentFlowDetail extends AgentFlow {
  versions: AgentFlowVersion[];
}

/** Flow 基本信息编辑输入；后端会同步最高版本号的草稿 Definition。 */
export interface AgentFlowMetadataInput {
  name: string;
  description?: string;
}

/** 内置模板：新建 Flow 的起点，避免手写整份 Definition */
export interface AgentFlowTemplate {
  preset: string;
  name: string;
  description: string;
  definition: object;
}

export interface AgentFlowValidation {
  valid: boolean;
  errors: FlowDefinitionValidationError[];
  digest?: string;
}

export interface AgentInput {
  name: string;
  description?: string;
  avatar?: string | null;
  systemPrompt?: string | null;
  modelPreset?: string | null;
  defaultFlowVersionId?: string | null;
  enabled?: boolean;
}
