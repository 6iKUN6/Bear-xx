import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAgent,
  createModelPreset,
  createModelProviderConnection,
  deleteAgent,
  deleteModelPreset,
  deleteModelProviderConnection,
  deleteTestSession,
  getAgentUsage,
  getErrorBreakdown,
  getOverview,
  getRecentTasks,
  getModelPresetReferences,
  getTaskDetail,
  getTestSession,
  getToolUsage,
  listAgents,
  listAdminUsers,
  updateUserMembership,
  updateUserAdminRole,
  listManagementAuditLogs,
  getAgentCapabilities,
  listAdminImageAssets,
  updateAdminImageAssetStatus,
  createAgentFlow,
  deleteAgentFlow,
  getAgentFlow,
  importFlowDefinition,
  listAgentFlowTemplates,
  listAgentFlows,
  listModelPresets,
  listModelProviderConnections,
  listModelProviderTemplates,
  publishFlowVersion,
  rollbackAgentFlow,
  updateFlowDraft,
  validateFlowVersion,
  probeModelPreset,
  probeModelProviderConnection,
  listTestSessions,
  setDefaultAgent,
  updateAgent,
  updateAgentFlowMetadata,
  updateModelPreset,
  updateModelProviderConnection,
} from "@/api/endpoints";
import type {
  AgentFlowMetadataInput,
  AgentInput,
  CreateModelPresetInput,
  CreateModelProviderConnectionInput,
  StorageAssetQuery,
  UpdateModelPresetInput,
  UpdateModelProviderConnectionInput,
} from "@/api/types";

export const useOverview = (days: number) =>
  useQuery({ queryKey: ["overview", days], queryFn: () => getOverview(days) });

export const useAgentUsage = (days: number) =>
  useQuery({
    queryKey: ["agentUsage", days],
    queryFn: () => getAgentUsage(days),
  });

export const useToolUsage = (days: number) =>
  useQuery({
    queryKey: ["toolUsage", days],
    queryFn: () => getToolUsage(days),
  });

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

export const useAdminUsers = (search: string | undefined, page: number) =>
  useQuery({
    queryKey: ["adminUsers", search ?? "", page],
    queryFn: () => listAdminUsers({ search, page, pageSize: 50 }),
  });

export const useManagementAuditLogs = () =>
  useQuery({
    queryKey: ["managementAuditLogs"],
    queryFn: () => listManagementAuditLogs({ page: 1, pageSize: 50 }),
  });

export function useAdminUserMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["adminUsers"] });
    void qc.invalidateQueries({ queryKey: ["managementAuditLogs"] });
  };
  const membership = useMutation({
    mutationFn: (input: {
      id: string;
      membershipTier: "FREE" | "PLUS" | "PRO";
      membershipExpiresAt: string | null;
    }) =>
      updateUserMembership(input.id, {
        membershipTier: input.membershipTier,
        membershipExpiresAt: input.membershipExpiresAt,
      }),
    onSuccess: invalidate,
  });
  const adminRole = useMutation({
    mutationFn: (input: {
      id: string;
      role: "USER" | "ADMIN" | "SUPER_ADMIN";
    }) => updateUserAdminRole(input.id, input.role),
    onSuccess: invalidate,
  });
  return { membership, adminRole };
}

/** 头像资产列表（复用选择器打开时才拉取） */
export const useAvatarAssets = (enabled: boolean) =>
  useQuery({
    queryKey: ["storageAssets", "agent-avatar"],
    queryFn: () =>
      listAdminImageAssets({
        page: 1,
        pageSize: 100,
        usage: "agent-avatar",
        status: "ACTIVE",
      }),
    select: (page) => page.items,
    enabled,
  });

/**
 * 查询图片资源分页
 * @param query 页码、搜索、用途与状态过滤
 * @returns 返回由完整查询条件隔离缓存的 TanStack Query 结果
 * @description 页面切换分页或筛选时保留上一页数据，避免网格在请求期间整体跳空。
 */
export const useStorageAssets = (query: StorageAssetQuery) =>
  useQuery({
    queryKey: [
      "storageAssets",
      query.page,
      query.pageSize,
      query.search ?? "",
      query.usage ?? "",
      query.status ?? "",
    ],
    queryFn: () => listAdminImageAssets(query),
    placeholderData: (previous) => previous,
  });

/** 图片资源软删除与恢复；成功后失效资源库和头像选择器的全部缓存。 */
export function useStorageAssetMutations() {
  const qc = useQueryClient();
  const status = useMutation({
    mutationFn: (input: { id: string; status: "ACTIVE" | "DELETED" }) =>
      updateAdminImageAssetStatus(input.id, input.status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["storageAssets"] });
    },
  });
  return { status };
}

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

/**
 * 查询单个模型预设的 Agent 与 Flow 引用
 * @param id 模型预设数据库 ID；null 表示当前没有编辑目标
 * @returns 返回引用汇总查询，停用确认前可 refetch 获取最新影响范围
 * @description 引用会随 Agent 和 Flow 配置变化，危险操作前由调用方主动刷新，不使用旧缓存做决定。
 */
export const useModelPresetReferences = (id: string | null) =>
  useQuery({
    queryKey: ["modelPresetReferences", id],
    queryFn: () => getModelPresetReferences(id as string),
    enabled: Boolean(id),
  });

export const useModelProviderTemplates = () =>
  useQuery({
    queryKey: ["modelProviderTemplates"],
    queryFn: listModelProviderTemplates,
    staleTime: Infinity,
  });

export const useModelProviderConnections = () =>
  useQuery({
    queryKey: ["modelProviderConnections"],
    queryFn: listModelProviderConnections,
  });

export function useModelProviderConnectionMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["modelProviderConnections"] });
    void qc.invalidateQueries({ queryKey: ["modelPresets"] });
    void qc.invalidateQueries({ queryKey: ["agentCapabilities"] });
  };
  const create = useMutation({
    mutationFn: (body: CreateModelProviderConnectionInput) =>
      createModelProviderConnection(body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: UpdateModelProviderConnectionInput;
    }) => updateModelProviderConnection(id, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteModelProviderConnection(id),
    onSuccess: invalidate,
  });
  const probe = useMutation({
    mutationFn: ({
      id,
      modelPresetId,
    }: {
      id: string;
      modelPresetId: string;
    }) => probeModelProviderConnection(id, modelPresetId),
    onSuccess: invalidate,
  });
  return { create, update, remove, probe };
}

export function useModelPresetMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["modelPresets"] });
    void qc.invalidateQueries({ queryKey: ["modelProviderConnections"] });
    void qc.invalidateQueries({ queryKey: ["agentCapabilities"] });
  };

  const create = useMutation({
    mutationFn: ({
      connectionId,
      body,
    }: {
      connectionId: string;
      body: CreateModelPresetInput;
    }) => createModelPreset(connectionId, body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateModelPresetInput }) =>
      updateModelPreset(id, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteModelPreset(id),
    onSuccess: invalidate,
  });
  // 已保存预设的探测会写回 capability，列表必须重取，否则徽章停在旧档位
  const probe = useMutation({
    mutationFn: (id: string) => probeModelPreset(id),
    onSuccess: invalidate,
  });

  return { create, update, remove, probe };
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
