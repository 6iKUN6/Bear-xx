import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createAgent,
  createModelPreset,
  deleteAgent,
  deleteModelPreset,
  deleteTestSession,
  getAgentUsage,
  getErrorBreakdown,
  getOverview,
  getRecentTasks,
  getTaskDetail,
  getTestSession,
  getToolUsage,
  listAgents,
  getAgentCapabilities,
  listAssets,
  listModelPresets,
  listTestSessions,
  updateAgent,
  updateModelPreset,
} from "@/api/endpoints";
import type { AgentInput, ModelPresetInput } from "@/api/types";

export const useOverview = (days: number) =>
  useQuery({ queryKey: ["overview", days], queryFn: () => getOverview(days) });

export const useAgentUsage = (days: number) =>
  useQuery({ queryKey: ["agentUsage", days], queryFn: () => getAgentUsage(days) });

export const useToolUsage = (days: number) =>
  useQuery({ queryKey: ["toolUsage", days], queryFn: () => getToolUsage(days) });

export const useErrorBreakdown = (days: number) =>
  useQuery({
    queryKey: ["errorBreakdown", days],
    queryFn: () => getErrorBreakdown(days),
  });

export const useRecentTasks = (days: number, cursor?: string) =>
  useQuery({
    queryKey: ["recentTasks", days, cursor ?? null],
    queryFn: () => getRecentTasks({ days, limit: 20, cursor }),
  });

export const useTaskDetail = (id: string | null) =>
  useQuery({
    queryKey: ["taskDetail", id],
    queryFn: () => getTaskDetail(id as string),
    enabled: Boolean(id),
  });

export const useAgents = () =>
  useQuery({ queryKey: ["agents"], queryFn: listAgents });

/** 头像资产列表（复用选择器打开时才拉取） */
export const useAvatarAssets = (enabled: boolean) =>
  useQuery({
    queryKey: ["storageAssets", "agent-avatar"],
    queryFn: () => listAssets({ usage: "agent-avatar" }),
    enabled,
  });

/** 能力闭集（工具组/工具）；注册表是静态闭集，长缓存 */
export const useAgentCapabilities = () =>
  useQuery({
    queryKey: ["agentCapabilities"],
    queryFn: getAgentCapabilities,
    staleTime: 5 * 60 * 1000,
  });

export function useAgentMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["agents"] });
    void qc.invalidateQueries({ queryKey: ["agentUsage"] });
  };

  const create = useMutation({
    mutationFn: (body: AgentInput) => createAgent(body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: AgentInput }) =>
      updateAgent(id, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAgent(id),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

export const useTestSessions = () =>
  useQuery({ queryKey: ["testSessions"], queryFn: listTestSessions });

export const useTestSession = (id: string | null) =>
  useQuery({
    queryKey: ["testSession", id],
    queryFn: () => getTestSession(id as string),
    enabled: Boolean(id),
  });

export function useDeleteTestSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTestSession(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["testSessions"] });
    },
  });
}

export const useModelPresets = () =>
  useQuery({ queryKey: ["modelPresets"], queryFn: listModelPresets });

export function useModelPresetMutations() {
  const qc = useQueryClient();
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["modelPresets"] });

  const create = useMutation({
    mutationFn: (body: ModelPresetInput) => createModelPreset(body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ModelPresetInput }) =>
      updateModelPreset(id, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteModelPreset(id),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
