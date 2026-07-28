import { request } from "./client";
import type {
  Agent,
  AgentInput,
  AgentUsage,
  AuthResponse,
  ErrorCategoryCount,
  ObservabilityOverview,
  RecentTasks,
  TaskDetail,
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

// ---- Agent CRUD ----
export const listAgents = () => request<Agent[]>("/agents");

export const createAgent = (body: AgentInput) =>
  request<Agent>("/agents", { method: "POST", body });

export const updateAgent = (id: string, body: AgentInput) =>
  request<Agent>(`/agents/${id}`, { method: "PATCH", body });

export const deleteAgent = (id: string) =>
  request<{ success: boolean }>(`/agents/${id}`, { method: "DELETE" });
