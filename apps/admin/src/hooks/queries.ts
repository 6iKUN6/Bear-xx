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
  getAgentUsage,
  getErrorBreakdown,
  getOverview,
  getRecentTasks,
  getTaskDetail,
  getToolUsage,
  listAgents,
  listModelPresets,
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
