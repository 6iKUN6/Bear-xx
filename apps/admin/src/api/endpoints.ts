import { request } from "./client";
import type {
  Agent,
  AgentCapabilities,
  StorageAsset,
  UploadCredential,
  AgentInput,
  AgentUsage,
  AuthResponse,
  ErrorCategoryCount,
  ModelPreset,
  ModelPresetInput,
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
export const getUploadCredential = (body: {
  type: "image" | "audio";
  ext: string;
  usage?: string;
}) => request<UploadCredential>("/storage/upload-credential", { method: "POST", body });

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
