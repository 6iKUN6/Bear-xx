import { request } from "./client";
import type {
  Agent,
  AgentCapabilities,
  StorageAsset,
  CosUploadCredential,
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
  ModelPreset,
  ModelPresetInput,
  ModelPresetProbeInput,
  ModelPresetProbeResult,
  ObservabilityOverview,
  RecentTasks,
  TaskDetail,
  TestSession,
  TestSessionDetail,
  ToolUsage,
} from "./types";

// ---- 鉴权 ----
export const login = (username: string, password: string) =>
  request<AuthResponse>("/auth/account/login", {
    method: "POST",
    body: { username, password },
    skipAuth: true,
  });

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
}) =>
  request<RecentTasks>("/admin/observability/tasks", { query: params });

export const getTaskDetail = (id: string) =>
  request<TaskDetail>(`/admin/observability/tasks/${id}`);

// ---- 对象存储 ----
export const getCosUploadCredential = (body: {
  type: "image" | "audio";
  ext: string;
}) =>
  request<CosUploadCredential>("/storage/cos/upload-credential", {
    method: "POST",
    body,
  });

export const registerAsset = (body: {
  key: string;
  usage?: string;
  size?: number;
  mimeType?: string;
}) => request<StorageAsset>("/storage/assets", { method: "POST", body });

export const listAssets = (query: { usage?: string; limit?: number }) =>
  request<StorageAsset[]>("/storage/assets", { query });

// ---- Agent CRUD ----
export const listAgents = () => request<Agent[]>("/agents");

export const getAgentCapabilities = () =>
  request<AgentCapabilities>("/admin/capabilities");

export const createAgent = (body: AgentInput) =>
  request<Agent>("/agents", { method: "POST", body });

export const updateAgent = (id: string, body: AgentInput) =>
  request<Agent>(`/agents/${id}`, { method: "PATCH", body });

export const setDefaultAgent = (id: string) =>
  request<Agent>(`/agents/${id}/default`, { method: "PATCH" });

export const deleteAgent = (id: string) =>
  request<{ success: boolean }>(`/agents/${id}`, { method: "DELETE" });

// ---- Admin 测试会话 ----
export const listTestSessions = () =>
  request<TestSession[]>("/admin/agent-tests/sessions");

export const getTestSession = (id: string) =>
  request<TestSessionDetail>(`/admin/agent-tests/sessions/${id}`);

export const deleteTestSession = (id: string) =>
  request<{ success: boolean }>(`/admin/agent-tests/sessions/${id}`, {
    method: "DELETE",
  });

// ---- ModelPreset CRUD ----
export const listModelPresets = () =>
  request<ModelPreset[]>("/admin/model-presets");

export const createModelPreset = (body: ModelPresetInput) =>
  request<ModelPreset>("/admin/model-presets", { method: "POST", body });

export const updateModelPreset = (id: string, body: ModelPresetInput) =>
  request<ModelPreset>(`/admin/model-presets/${id}`, { method: "PATCH", body });

export const deleteModelPreset = (id: string) =>
  request<{ success: boolean }>(`/admin/model-presets/${id}`, {
    method: "DELETE",
  });

/** 用表单里的连接参数试探；不落库，也不改动任何预设的 capability */
export const probeModelPresetDraft = (body: ModelPresetProbeInput) =>
  request<ModelPresetProbeResult>("/admin/model-presets/probe", {
    method: "POST",
    body,
  });

/** 用已落库的密文密钥探测，结论写回该预设的 capability 与 lastCheck* */
export const probeModelPreset = (id: string) =>
  request<ModelPresetProbeResult>(`/admin/model-presets/${id}/probe`, {
    method: "POST",
  });

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

export const publishFlowVersion = (versionId: string) =>
  request<AgentFlowVersion>(
    `/admin/agent-flow-versions/${versionId}/publish`,
    { method: "POST" },
  );

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
