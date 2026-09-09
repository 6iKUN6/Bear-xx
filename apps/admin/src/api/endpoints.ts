import { request } from "./client";
import type {
  Agent,
  AgentCapabilities,
  StorageAsset,
  AdminImageUploadCredential,
  AdminImageUploadUsage,
  StorageAssetPage,
  StorageAssetQuery,
  StorageAssetStatus,
  AgentInput,
  AgentUsage,
  AuthResponse,
  ErrorCategoryCount,
  AgentFlow,
  AgentFlowDetail,
  AgentFlowMetadataInput,
  AgentFlowTemplate,
  AgentFlowValidation,
  AgentFlowVersion,
  AdminUser,
  AdminUserPage,
  ManagementAuditPage,
  CreateModelPresetInput,
  CreateModelProviderConnectionInput,
  ModelPreset,
  ModelPresetProbeResult,
  ModelPresetReferences,
  ModelProviderConnection,
  ModelProviderConnectionProbeResult,
  ModelProviderTemplate,
  UpdateModelPresetInput,
  UpdateModelProviderConnectionInput,
  ObservabilityOverview,
  RecentTasks,
  TaskDetail,
  TestSession,
  TestSessionDetail,
  ToolUsage,
} from "./types";

// ---- 鉴权 ----
export const login = (account: string, password: string) =>
  request<AuthResponse>("/admin/auth/login", {
    method: "POST",
    body: { username: account, password },
    skipAuth: true,
  });

export const getAdminSession = () =>
  request<AuthResponse["user"]>("/admin/auth/session");

// ---- 观测 ----
export const getOverview = (days?: number) =>
  request<ObservabilityOverview>("/admin/observability/overview", {
    query: { days },
  });

export const getAgentUsage = (days?: number) =>
  request<AgentUsage[]>("/admin/observability/agents", { query: { days } });

export const getToolUsage = (days?: number) =>
  request<ToolUsage[]>("/admin/observability/tools", { query: { days } });

export const getErrorBreakdown = (days?: number) =>
  request<ErrorCategoryCount[]>("/admin/observability/errors", {
    query: { days },
  });

export const getRecentTasks = (params: {
  days?: number;
  limit?: number;
  cursor?: string;
}) => request<RecentTasks>("/admin/observability/tasks", { query: params });

export const getTaskDetail = (id: string) =>
  request<TaskDetail>(`/admin/observability/tasks/${id}`);

// ---- 对象存储 ----
export const getAdminImageUploadCredential = (body: {
  ext: string;
  usage: AdminImageUploadUsage;
  size: number;
}) =>
  request<AdminImageUploadCredential>("/admin/storage/upload-credential", {
    method: "POST",
    body,
  });

export const registerAdminImageAsset = (body: {
  key: string;
  usage: AdminImageUploadUsage;
  size: number;
  mimeType: string;
  originalName: string;
}) => request<StorageAsset>("/admin/storage/assets", { method: "POST", body });

export const listAdminImageAssets = (query: StorageAssetQuery) =>
  request<StorageAssetPage>("/admin/storage/assets", {
    query: {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      usage: query.usage,
      status: query.status,
    },
  });

export const updateAdminImageAssetStatus = (
  id: string,
  status: Extract<StorageAssetStatus, "ACTIVE" | "DELETED">,
) =>
  request<StorageAsset>(`/admin/storage/assets/${id}/status`, {
    method: "PATCH",
    body: { status },
  });

// ---- Agent CRUD ----
export const listAgents = () => request<Agent[]>("/admin/agents");

export const getAgentCapabilities = () =>
  request<AgentCapabilities>("/admin/capabilities");

export const createAgent = (body: AgentInput) =>
  request<Agent>("/admin/agents", { method: "POST", body });

export const updateAgent = (id: string, body: AgentInput) =>
  request<Agent>(`/admin/agents/${id}`, { method: "PATCH", body });

export const setDefaultAgent = (id: string) =>
  request<Agent>(`/admin/agents/${id}/default`, { method: "PATCH" });

export const deleteAgent = (id: string) =>
  request<{ success: boolean }>(`/admin/agents/${id}`, { method: "DELETE" });

export const listAdminUsers = (query?: {
  page?: number;
  pageSize?: number;
  search?: string;
}) => request<AdminUserPage>("/admin/users", { query });

export const updateUserMembership = (
  id: string,
  body: {
    membershipTier: "FREE" | "PLUS" | "PRO";
    membershipExpiresAt: string | null;
  },
) =>
  request<AdminUser>(`/admin/users/${id}/membership`, {
    method: "PATCH",
    body,
  });

export const updateUserAdminRole = (
  id: string,
  role: "USER" | "ADMIN" | "SUPER_ADMIN",
) =>
  request<AdminUser>(`/admin/users/${id}/admin-role`, {
    method: "PATCH",
    body: { role },
  });

export const listManagementAuditLogs = (query?: {
  page?: number;
  pageSize?: number;
}) => request<ManagementAuditPage>("/admin/audit-logs", { query });

// ---- Admin 测试会话 ----
export const listTestSessions = () =>
  request<TestSession[]>("/admin/agent-tests/sessions");

export const getTestSession = (id: string) =>
  request<TestSessionDetail>(`/admin/agent-tests/sessions/${id}`);

export const deleteTestSession = (id: string) =>
  request<{ success: boolean }>(`/admin/agent-tests/sessions/${id}`, {
    method: "DELETE",
  });

// ---- 模型供应商连接与预设 ----
export const listModelProviderTemplates = () =>
  request<ModelProviderTemplate[]>("/admin/model-provider-templates");

export const listModelProviderConnections = () =>
  request<ModelProviderConnection[]>("/admin/model-provider-connections");

export const createModelProviderConnection = (
  body: CreateModelProviderConnectionInput,
) =>
  request<ModelProviderConnection>("/admin/model-provider-connections", {
    method: "POST",
    body,
  });

export const updateModelProviderConnection = (
  id: string,
  body: UpdateModelProviderConnectionInput,
) =>
  request<ModelProviderConnection>(`/admin/model-provider-connections/${id}`, {
    method: "PATCH",
    body,
  });

export const deleteModelProviderConnection = (id: string) =>
  request<{ success: boolean }>(`/admin/model-provider-connections/${id}`, {
    method: "DELETE",
  });

export const probeModelProviderConnection = (
  id: string,
  modelPresetId: string,
) =>
  request<ModelProviderConnectionProbeResult>(
    `/admin/model-provider-connections/${id}/probe`,
    { method: "POST", body: { modelPresetId } },
  );

export const listModelPresets = () =>
  request<ModelPreset[]>("/admin/model-presets");

export const createModelPreset = (
  connectionId: string,
  body: CreateModelPresetInput,
) =>
  request<ModelPreset>(
    `/admin/model-provider-connections/${connectionId}/models`,
    { method: "POST", body },
  );

export const updateModelPreset = (id: string, body: UpdateModelPresetInput) =>
  request<ModelPreset>(`/admin/model-presets/${id}`, { method: "PATCH", body });

export const deleteModelPreset = (id: string) =>
  request<{ success: boolean }>(`/admin/model-presets/${id}`, {
    method: "DELETE",
  });

/** 用已落库的密文密钥探测，结论写回该预设的 capability 与 lastCheck* */
export const probeModelPreset = (id: string) =>
  request<ModelPresetProbeResult>(`/admin/model-presets/${id}/probe`, {
    method: "POST",
  });

export const getModelPresetReferences = (id: string) =>
  request<ModelPresetReferences>(`/admin/model-presets/${id}/references`);

// ---- AgentFlow 控制面 ----
export const listAgentFlows = () => request<AgentFlow[]>("/admin/agent-flows");

export const getAgentFlow = (flowId: string) =>
  request<AgentFlowDetail>(`/admin/agent-flows/${flowId}`);

export const updateAgentFlowMetadata = (
  flowId: string,
  body: AgentFlowMetadataInput,
) =>
  request<AgentFlow>(`/admin/agent-flows/${flowId}`, {
    method: "PATCH",
    body,
  });

/** 创建 Flow 与其 version 1 草稿；definition 即完整 FlowDefinition */
export const createAgentFlow = (definition: object) =>
  request<AgentFlow>("/admin/agent-flows", {
    method: "POST",
    body: { definition },
  });

export const deleteAgentFlow = (flowId: string) =>
  request<{ success: boolean }>(`/admin/agent-flows/${flowId}`, {
    method: "DELETE",
  });

export const listAgentFlowTemplates = () =>
  request<AgentFlowTemplate[]>("/admin/agent-flow-templates");

/** 整份覆盖草稿；服务端不接受局部 patch，避免图工件半更新 */
export const updateFlowDraft = (versionId: string, definition: object) =>
  request<AgentFlowVersion>(`/admin/agent-flow-versions/${versionId}`, {
    method: "PUT",
    body: { definition },
  });

export const validateFlowVersion = (versionId: string) =>
  request<AgentFlowValidation>(
    `/admin/agent-flow-versions/${versionId}/validate`,
    { method: "POST" },
  );

/** 校验当前未保存 Definition，不创建或更新 Flow 版本。 */
export const validateFlowDefinition = (definition: object) =>
  request<AgentFlowValidation>("/admin/agent-flows/validate-definition", {
    method: "POST",
    body: { definition },
  });

export const publishFlowVersion = (versionId: string) =>
  request<AgentFlowVersion>(`/admin/agent-flow-versions/${versionId}/publish`, {
    method: "POST",
  });

export const exportFlowVersion = (versionId: string) =>
  request<object>(`/admin/agent-flow-versions/${versionId}/export`);

/** 导入永远递增创建新草稿，不覆盖任何既有版本 */
export const importFlowDefinition = (flowId: string, definition: object) =>
  request<AgentFlowVersion>(`/admin/agent-flows/${flowId}/import`, {
    method: "POST",
    body: { definition },
  });

export const rollbackAgentFlow = (flowId: string, versionId: string) =>
  request<AgentFlowVersion>(`/admin/agent-flows/${flowId}/rollback`, {
    method: "POST",
    body: { versionId },
  });
