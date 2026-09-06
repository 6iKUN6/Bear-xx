import { useEffect, useState } from "react";
import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import AgentAvatar from "../../components/AgentAvatar";
import AppIcon from "../../components/AppIcon";
import NavBar from "../../components/NavBar";
import PageShell from "../../components/PageShell";
import { useAgentStore } from "../../store/agentStore";
import { useChatStore } from "../../store/chatStore";
import { createConversation } from "../../api/chat";
import { ApiRequestError } from "../../api/request";
import { safeAreaBottom } from "../../utils/style";

/**
 * 发起群聊 · 多选智能体
 * @description 勾选 ≥2 个智能体建群（后端 defaultAgentId 留空 = 自动路由）；
 * 底部实时显示已选头像堆叠。恰选 1 个时降级为发起单聊。
 */
export default function AgentPickerPage() {
  const agents = useAgentStore((state) => state.agents);
  const ensureAgents = useAgentStore((state) => state.ensureAgents);
  const upsertConversation = useChatStore((state) => state.upsertConversation);
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void ensureAgents();
  }, [ensureAgents]);

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const selectedAgents = agents.filter((a) => selected.includes(a.id));
  const canSubmit =
    selected.length >= 1 &&
    selectedAgents.length === selected.length &&
    selectedAgents.every((agent) => agent.canUse) &&
    !creating;

  const handleCreate = async () => {
    if (!canSubmit) return;
    setCreating(true);
    try {
      const conversation = await createConversation(
        selected.length === 1
          ? { type: "SINGLE", agentIds: selected }
          : { type: "GROUP", agentIds: selected },
      );
      upsertConversation(conversation);
      await Taro.redirectTo({ url: "/pages/index/index" });
    } catch (error) {
      console.error("Create group chat failed:", error);
      void useAgentStore.getState().loadAgents();
      // API 层已经展示服务端的明确拒绝原因，避免再追加重复 toast。
      if (!(error instanceof ApiRequestError)) {
        void Taro.showToast({ title: "创建失败，请重试", icon: "none" });
      }
      setCreating(false);
    }
  };

  return (
    <PageShell>
      <NavBar
        title="选择智能体"
        showBack
        capsule="hidden"
        right={
          <Text className="text-[0.75rem] leading-none text-[var(--lb-text-muted)]">
            {selected.length}/{agents.length}
          </Text>
        }
      />

      <View className="min-h-0 flex-1 overflow-y-auto">
        {agents.map((agent) => {
          const on = selected.includes(agent.id);
          const selectable = agent.canUse;
          return (
            <View
              key={agent.id}
              className={`flex items-center gap-[0.75rem] px-[1rem] py-[0.625rem] ${selectable ? "active:bg-[var(--lb-surface-hover)]" : "opacity-55"}`}
              onClick={() => selectable && toggle(agent.id)}
            >
              <AgentAvatar
                className="h-[2.625rem] w-[2.625rem] shrink-0 rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface)]"
                name={agent.name}
                avatar={agent.avatar}
                size="md"
              />
              <View className="min-w-0 flex-1">
                <Text className="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.9375rem] font-medium leading-[1.35] text-[var(--lb-text-primary)]">
                  {agent.name}
                </Text>
                {agent.description ? (
                  <Text className="mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.4] text-[var(--lb-text-muted)]">
                    {agent.description}
                  </Text>
                ) : null}
                {!selectable ? (
                  <Text className="mt-[0.125rem] block text-[0.6875rem] leading-[1.4] text-[var(--lb-warning)]">
                    {agent.accessReason === "DISABLED"
                      ? "暂不可用"
                      : `需要 ${agent.requiredTier} 会员`}
                  </Text>
                ) : null}
              </View>
              <View
                className={`flex h-[1.375rem] w-[1.375rem] shrink-0 items-center justify-center rounded-full border ${
                  on
                    ? "border-[var(--lb-accent)] bg-[var(--lb-accent)]"
                    : "border-[var(--lb-line)] bg-transparent"
                }`}
              >
                {on ? (
                  <AppIcon name="check" className="h-[0.75rem] w-[0.75rem] text-[var(--lb-on-accent)]" />
                ) : null}
              </View>
            </View>
          );
        })}
      </View>

      <View
        className="flex items-center gap-[0.5rem] border-t border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[0.875rem] pt-[0.625rem] box-border"
        style={{ paddingBottom: safeAreaBottom(12) }}
      >
        <View className="flex min-w-0 flex-1 items-center">
          {selectedAgents.slice(0, 6).map((agent, index) => (
            <AgentAvatar
              key={agent.id}
              className={`h-[2rem] w-[2rem] rounded-full border-2 border-[var(--lb-surface)] bg-[var(--lb-page-background)] ${
                index > 0 ? "ml-[-0.5rem]" : ""
              }`}
              name={agent.name}
              avatar={agent.avatar}
              size="sm"
            />
          ))}
          <Text className="ml-[0.5rem] shrink-0 text-[0.75rem] leading-[1.3] text-[var(--lb-text-secondary)]">
            已选 {selected.length} 个
          </Text>
        </View>
        <View
          className={`rounded-[0.6875rem] px-[1.125rem] py-[0.5625rem] ${
            canSubmit
              ? "bg-[var(--lb-accent)] active:scale-95"
              : "bg-[var(--lb-accent)] opacity-40"
          }`}
          onClick={() => void handleCreate()}
        >
          <Text className="text-[0.8125rem] font-semibold leading-none text-[var(--lb-on-accent)]">
            {creating
              ? "创建中…"
              : selected.length === 1
                ? "发起单聊"
                : "建群聊天"}
          </Text>
        </View>
      </View>
    </PageShell>
  );
}
