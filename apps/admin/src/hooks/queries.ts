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
  createAgentFlow,
  deleteAgentFlow,
  getAgentFlow,
  importFlowDefinition,
  listAgentFlowTemplates,
  listAgentFlows,
  listModelPresets,
  publishFlowVersion,
  rollbackAgentFlow,
  updateFlowDraft,
  validateFlowVersion,
  probeModelPreset,
  probeModelPresetDraft,
  listTestSessions,
  setDefaultAgent,
  updateAgent,
  updateAgentFlowMetadata,
  updateModelPreset,
} from "@/api/endpoints";
import type {
  AgentFlowMetadataInput,
  AgentInput,
  ModelPresetInput,
  ModelPresetProbeInput,
} from "@/api/types";

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
  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["agents"] }),
      qc.invalidateQueries({ queryKey: ["agentUsage"] }),
    ]);
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
  const setDefault = useMutation({
    mutationFn: (id: string) => setDefaultAgent(id),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAgent(id),
    onSuccess: invalidate,
  });
  return { create, update, setDefault, remove };
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
  // 保存前试探：不落库，因此也不需要失效列表
  const probeDraft = useMutation({
    mutationFn: (body: ModelPresetProbeInput) => probeModelPresetDraft(body),
  });
  // 已保存预设的探测会写回 capability，列表必须重取，否则徽章停在旧档位
  const probe = useMutation({
    mutationFn: (id: string) => probeModelPreset(id),
    onSuccess: invalidate,
  });

  return { create, update, remove, probe, probeDraft };
}

/* ── AgentFlow ─────────────────────────────────────────────── */

export const useAgentFlows = () =>
  useQuery({ queryKey: ["agentFlows"], queryFn: listAgentFlows });

export const useAgentFlow = (flowId: string | undefined) =>
  useQuery({
    queryKey: ["agentFlow", flowId],
    queryFn: () => getAgentFlow(flowId as string),
    enabled: Boolean(flowId),
  });

/** 内置模板是纯常量，服务端每次重新构造，缓存起来即可 */
export const useAgentFlowTemplates = () =>
  useQuery({
    queryKey: ["agentFlowTemplates"],
    queryFn: listAgentFlowTemplates,
    staleTime: Infinity,
  });

export function useAgentFlowMutations(flowId?: string) {
  const qc = useQueryClient();
  // 版本状态改变会同时影响列表的发布版本摘要和详情的版本历史，两个 key 都要失效
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["agentFlows"] });
    if (flowId) {
      void qc.invalidateQueries({ queryKey: ["agentFlow", flowId] });
    }
  };

  const create = useMutation({
    mutationFn: (definition: object) => createAgentFlow(definition),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAgentFlow(id),
    onSuccess: invalidate,
  });
  const updateMetadata = useMutation({
    mutationFn: (input: { flowId: string; body: AgentFlowMetadataInput }) =>
      updateAgentFlowMetadata(input.flowId, input.body),
    onSuccess: invalidate,
  });
  const saveDraft = useMutation({
    mutationFn: (input: { versionId: string; definition: object }) =>
      updateFlowDraft(input.versionId, input.definition),
    onSuccess: invalidate,
  });
  // 校验是只读的，不触发失效
  const validate = useMutation({
    mutationFn: (versionId: string) => validateFlowVersion(versionId),
  });
  const publish = useMutation({
    mutationFn: (versionId: string) => publishFlowVersion(versionId),
    onSuccess: invalidate,
  });
  const importDefinition = useMutation({
    mutationFn: (input: { flowId: string; definition: object }) =>
      importFlowDefinition(input.flowId, input.definition),
    onSuccess: invalidate,
  });
  const rollback = useMutation({
    mutationFn: (input: { flowId: string; versionId: string }) =>
      rollbackAgentFlow(input.flowId, input.versionId),
    onSuccess: invalidate,
  });

  return {
    create,
    updateMetadata,
    remove,
    saveDraft,
    validate,
    publish,
    importDefinition,
    rollback,
  };
}
