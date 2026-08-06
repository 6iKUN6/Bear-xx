import { useState } from "react";
import { Image, View, Text } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import NavBar from "../../components/NavBar";
import PageShell from "../../components/PageShell";
import { useAgentStore } from "../../store/agentStore";
import { useChatStore } from "../../store/chatStore";
import { createConversation } from "../../api/chat";
import { agentAvatarSrc, toolGroupLabel } from "../../utils/agent";
import { appGlassCardClass } from "../../utils/style";
import type { AgentSummary } from "../../api/agents";

/**
 * 智能体通讯录（Tab 页）
 * @description 网格卡片浏览全部可用智能体：点「单聊」进入/复用与该智能体的
 * 1:1 会话（后端幂等）；右下角悬浮按钮发起群聊（多选页）。
 */
export default function AgentsPage() {
  const agents = useAgentStore((state) => state.agents);
  const loaded = useAgentStore((state) => state.loaded);
  const loadAgents = useAgentStore((state) => state.loadAgents);
  const upsertConversation = useChatStore((state) => state.upsertConversation);
  const [creating, setCreating] = useState<string | null>(null);

  // 通讯录是「看最新列表」的场景：每次进入无条件刷新（其它页面用 ensureAgents 即可）
  useDidShow(() => {
    void loadAgents();
  });

  const handleSingleChat = async (agent: AgentSummary) => {
    if (creating) return;
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
      void Taro.showToast({ title: "发起单聊失败", icon: "none" });
    } finally {
      setCreating(null);
    }
  };

  return (
    <PageShell>
      <NavBar title="智能体" showBack capsule="hidden" />

      <View className="min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+4.5rem)]">
        <View className="grid grid-cols-2 gap-[0.625rem] px-[0.875rem] pt-[0.5rem]">
          {agents.map((agent) => (
            <View
              key={agent.id}
              className={`${appGlassCardClass} box-border flex flex-col items-center px-[0.75rem] py-[0.875rem] text-center`}
            >
              <Image
                className="h-[3.25rem] w-[3.25rem] rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface)]"
                src={agentAvatarSrc(agent.avatar)}
                mode="aspectFill"
              />
              <Text className="mt-[0.5rem] block w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.9375rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
                {agent.name}
              </Text>
              <Text className="mt-[0.25rem] block h-[2.125rem] w-full overflow-hidden text-[0.6875rem] leading-[1.55] text-[var(--lb-text-secondary)]">
                {agent.description || "暂无简介"}
              </Text>
              <View className="mt-[0.375rem] flex min-h-[1.125rem] flex-wrap items-center justify-center gap-[0.25rem]">
                {(agent.toolGroups ?? []).slice(0, 2).map((group) => (
                  <Text
                    key={group}
                    className="rounded-[0.3125rem] bg-[var(--lb-accent-soft)] px-[0.375rem] py-[0.125rem] text-[0.625rem] leading-[1.3] text-[var(--lb-accent-ink)]"
                  >
                    {toolGroupLabel(group)}
                  </Text>
                ))}
              </View>
              <View
                className="mt-[0.625rem] w-full rounded-[0.5625rem] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] py-[0.375rem] text-center active:bg-[var(--lb-surface-hover)]"
                onClick={() => void handleSingleChat(agent)}
              >
                <Text className="text-[0.75rem] font-medium leading-[1.3] text-[var(--lb-text-primary)]">
                  {creating === agent.id ? "进入中…" : "单聊"}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {loaded && agents.length === 0 ? (
          <Text className="block px-[1.5rem] pt-[3rem] text-center text-[0.875rem] leading-[1.6] text-[var(--lb-text-muted)]">
            暂无可用智能体
          </Text>
        ) : null}
      </View>

      {/* 发起群聊 */}
      <View
        className="fixed right-[1.125rem] z-40 flex items-center gap-[0.375rem] rounded-[0.875rem] bg-[var(--lb-accent)] px-[1rem] py-[0.6875rem] shadow-[var(--lb-shadow-glow)] active:scale-95"
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
        onClick={() =>
          void Taro.navigateTo({ url: "/pages/agent-picker/index" })
        }
      >
        <Text className="at-icon at-icon-add-circle text-[1rem] leading-none text-[var(--lb-on-accent)] [&::before]:block" />
        <Text className="text-[0.8125rem] font-semibold leading-none text-[var(--lb-on-accent)]">
          发起群聊
        </Text>
      </View>
    </PageShell>
  );
}
