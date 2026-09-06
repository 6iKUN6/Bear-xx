import { useState } from "react";
import { View, Text } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import AgentAvatar from "../../components/AgentAvatar";
import AppIcon from "../../components/AppIcon";
import NavBar from "../../components/NavBar";
import PageShell from "../../components/PageShell";
import { useAgentStore } from "../../store/agentStore";
import { useChatStore } from "../../store/chatStore";
import { createConversation } from "../../api/chat";
import { ApiRequestError } from "../../api/request";
import { toolGroupLabel } from "../../utils/agent";
import type { AgentSummary } from "../../api/agents";

/**
 * 智能体通讯录（Tab 页）
 * @description 网格卡片浏览全部可用智能体：点「发起单聊」进入/复用与该智能体的
 * 1:1 会话（后端幂等）；右下角悬浮按钮发起群聊（多选页）。
 */
export default function AgentsPage() {
  const agents = useAgentStore((state) => state.agents);
  const loaded = useAgentStore((state) => state.loaded);
  const loadAgents = useAgentStore((state) => state.loadAgents);
  const loadError = useAgentStore((state) => state.loadError);
  const upsertConversation = useChatStore((state) => state.upsertConversation);
  const [creating, setCreating] = useState<string | null>(null);

  // 通讯录是「看最新列表」的场景：每次进入无条件刷新（其它页面用 ensureAgents 即可）
  useDidShow(() => {
    void loadAgents();
  });

  const handleSingleChat = async (agent: AgentSummary) => {
    if (creating) return;
    if (!agent.canUse) {
      const message =
        agent.accessReason === "DISABLED"
          ? "该智能体暂不可用"
          : agent.accessReason === "MEMBERSHIP_EXPIRED"
            ? `会员已到期，需要 ${agent.requiredTier} 会员`
            : `需要 ${agent.requiredTier} 会员，暂不支持自助升级`;
      void Taro.showToast({ title: message, icon: "none" });
      return;
    }
    setCreating(agent.id);
    try {
      // 后端幂等：同绑定的既有单聊直接复用
      const conversation = await createConversation({
        type: "SINGLE",
        agentIds: [agent.id],
      });
      upsertConversation(conversation);
      await Taro.redirectTo({ url: "/pages/index/index" });
    } catch (error) {
      console.error("Create single chat failed:", error);
      void loadAgents();
      // API 层已经展示服务端的明确拒绝原因，避免再用通用提示覆盖一次。
      if (!(error instanceof ApiRequestError)) {
        void Taro.showToast({ title: "发起单聊失败", icon: "none" });
      }
    } finally {
      setCreating(null);
    }
  };

  return (
    <PageShell>
      <NavBar
        title="智能体"
        subtitle={loaded && agents.length > 0 ? `${agents.length} 位可用` : undefined}
        showBack
        capsule="hidden"
      />

      <View className="min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+4.5rem)]">
        <View className="grid grid-cols-2 gap-[0.625rem] p-[0.875rem]">
          {agents.map((agent) => {
            const subtitle = agent.isDefault
              ? "默认助手"
              : (agent.toolGroups ?? [])
                  .slice(0, 2)
                  .map(toolGroupLabel)
                  .join(" · ");

            return (
              <View
                key={agent.id}
                className="box-border flex flex-col gap-[0.5rem] rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] p-[0.875rem] shadow-[var(--lb-shadow-card)]"
              >
                <View className="flex items-center gap-[0.625rem]">
                  <AgentAvatar
                    className="h-[2.5rem] w-[2.5rem] shrink-0 rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] box-border"
                    name={agent.name}
                    avatar={agent.avatar}
                    size="md"
                  />
                  <View className="min-w-0 flex-1">
                    <Text className="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.875rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
                      {agent.name}
                    </Text>
                    {subtitle ? (
                      <Text className="mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] leading-[1.35] text-[var(--lb-text-muted)]">
                        {subtitle}
                      </Text>
                    ) : null}
                  </View>
                </View>

                <Text className="block h-[2.25rem] overflow-hidden text-[0.75rem] leading-[1.5] text-[var(--lb-text-secondary)]">
                  {agent.description || "暂无简介"}
                </Text>

                <View className="flex min-h-[1.125rem] flex-wrap items-center gap-[0.25rem]">
                  {agent.minimumMembershipTier !== "FREE" ? (
                    <Text className="rounded-full bg-[var(--lb-warning-soft)] px-[0.5rem] py-[0.1875rem] text-[0.625rem] leading-[1.3] text-[var(--lb-warning)]">
                      {agent.minimumMembershipTier}
                    </Text>
                  ) : null}
                  {(agent.toolGroups ?? []).slice(0, 2).map((group) => (
                    <Text
                      key={group}
                      className="rounded-full bg-[var(--lb-surface-muted)] px-[0.5rem] py-[0.1875rem] text-[0.625rem] leading-[1.3] text-[var(--lb-text-secondary)]"
                    >
                      {toolGroupLabel(group)}
                    </Text>
                  ))}
                </View>

                <View
                  className={`mt-auto box-border flex min-h-[2.25rem] w-full items-center justify-center rounded-[var(--lb-radius-sm)] border ${
                    agent.canUse
                      ? "border-[var(--lb-line-strong)] bg-[var(--lb-surface)] active:bg-[var(--lb-surface-hover)]"
                      : "border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] opacity-70"
                  }`}
                  onClick={() => void handleSingleChat(agent)}
                >
                  <Text className="text-[0.8125rem] font-medium leading-[1.3] text-[var(--lb-text-primary)]">
                    {creating === agent.id
                      ? "进入中…"
                      : agent.canUse
                        ? "发起单聊"
                        : agent.accessReason === "DISABLED"
                          ? "暂不可用"
                          : `需要 ${agent.requiredTier}`}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>

        {loadError && agents.length === 0 ? (
          <View className="px-[1.5rem] pt-[3rem] text-center">
            <Text className="block text-[0.875rem] leading-[1.6] text-[var(--lb-danger)]">
              智能体列表加载失败
            </Text>
            <View
              className="mx-auto mt-[0.75rem] w-fit rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] bg-[var(--lb-surface)] px-[0.9375rem] py-[0.4375rem] active:bg-[var(--lb-surface-hover)]"
              onClick={() => void loadAgents()}
            >
              <Text className="text-[0.8125rem] font-medium text-[var(--lb-text-primary)]">
                重新加载
              </Text>
            </View>
          </View>
        ) : loaded && agents.length === 0 ? (
          <Text className="block px-[1.5rem] pt-[3rem] text-center text-[0.875rem] leading-[1.6] text-[var(--lb-text-muted)]">
            暂无可用智能体
          </Text>
        ) : null}
      </View>

      {/* 发起群聊 */}
      <View
        className="fixed right-[1rem] z-40 flex items-center gap-[0.375rem] rounded-full bg-[var(--lb-accent-surface)] px-[1.0625rem] py-[0.6875rem] shadow-[var(--lb-shadow-glow)] active:scale-95"
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 1.25rem)" }}
        onClick={() =>
          void Taro.navigateTo({ url: "/pages/agent-picker/index" })
        }
      >
        <AppIcon name="group" className="h-[1rem] w-[1rem] text-[var(--lb-on-accent)]" />
        <Text className="text-[0.8125rem] font-semibold leading-none text-[var(--lb-on-accent)]">
          发起群聊
        </Text>
      </View>
    </PageShell>
  );
}
