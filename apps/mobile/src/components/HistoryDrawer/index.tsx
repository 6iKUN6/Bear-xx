import { useEffect, useState } from "react";
import { Image, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useNavBarMetrics } from "../../hooks/useNavBarMetrics";
import { useAgentStore } from "../../store/agentStore";
import { useUserStore } from "../../store/userStore";
import { groupConversationsByTime } from "../../utils/conversation";
import { agentAvatarSrc } from "../../utils/agent";
import { appTextTruncateClass } from "../../utils/style";
import type { AgentSummary } from "../../api/agents";

const DRAWER_TRANSITION_MS = 220;

interface HistoryDrawerProps {
  open: boolean;
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onOpenAgents: () => void;
  onOpenSettings: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/**
 * 左侧会话抽屉
 * @description 消息流保持在下层，抽屉顶部提供新对话与智能体入口；中段按时间展示
 * 会话历史，底部收拢账号状态和设置。尺寸依赖小程序胶囊测量值，避免与状态栏重叠。
 */
export default function HistoryDrawer({
  open,
  conversations,
  currentId,
  onSelect,
  onCreate,
  onOpenAgents,
  onOpenSettings,
  onDelete,
  onClose,
}: HistoryDrawerProps) {
  const metrics = useNavBarMetrics();
  const agents = useAgentStore((state) => state.agents);
  const { isLoggedIn, userInfo } = useUserStore();
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      Taro.nextTick(() => setActive(true));
    } else {
      setActive(false);
      closeTimer = setTimeout(() => setMounted(false), DRAWER_TRANSITION_MS);
    }

    return () => {
      if (closeTimer) {
        clearTimeout(closeTimer);
      }
    };
  }, [open]);

  if (!mounted) {
    return null;
  }

  const groups = groupConversationsByTime(conversations);
  const accountName = isLoggedIn ? userInfo?.nickname || "小熊用户" : "未登录";
  const accountHint = isLoggedIn ? "账号已连接" : "登录后同步会话与主题";

  const closeDrawer = () => {
    setActive(false);
    onClose();
  };

  const handleDelete = (conversation: Conversation) => {
    void Taro.showModal({
      title: "删除会话",
      content: `确定删除「${conversation.title || "新对话"}」？`,
      confirmColor: "#e5484d",
    }).then((res) => {
      if (res.confirm) {
        onDelete(conversation.id);
      }
    });
  };

  return (
    <View className="fixed inset-0 z-[70]" onClick={closeDrawer}>
      <View
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${
          active ? "opacity-100" : "opacity-0"
        }`}
      />
      <View
        className={`relative box-border flex h-full w-[84%] max-w-[20.5rem] flex-col border-r border-[var(--lb-line-soft)] bg-[var(--lb-surface)] shadow-[12px_0_34px_rgba(13,27,21,0.18)] transition-transform duration-200 ease-out ${
          active ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{
          paddingTop:
            typeof metrics.topPadding === "number"
              ? metrics.topPadding
              : metrics.topPadding,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <View
          className="flex items-center justify-between border-b border-[var(--lb-line-soft)] px-[0.875rem]"
          style={{ minHeight: metrics.contentHeight }}
        >
          <View className="flex min-w-0 items-center gap-[0.5rem]">
            <View className="flex h-[1.5rem] w-[1.5rem] shrink-0 items-center justify-center rounded-[0.375rem] bg-[var(--lb-accent)]">
              <Text className="text-[0.75rem] font-bold leading-none text-[var(--lb-on-accent)]">
                办
              </Text>
            </View>
            <Text className="block overflow-hidden text-ellipsis whitespace-nowrap text-[1rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
              办伴
            </Text>
          </View>
          <View
            className="flex h-[2.25rem] w-[2.25rem] items-center justify-center rounded-[var(--lb-radius-sm)] text-[var(--lb-text-secondary)] active:bg-[var(--lb-surface-hover)]"
            onClick={closeDrawer}
          >
            <Text className="at-icon at-icon-close text-[1rem] leading-none [&::before]:block" />
          </View>
        </View>

        <View className="min-h-0 flex-1 overflow-y-auto px-[0.75rem] py-[0.75rem]">
          <View className="grid gap-[0.5rem]">
            <View
              className="flex min-h-[2.75rem] items-center gap-[0.625rem] rounded-[var(--lb-radius-sm)] bg-[var(--lb-accent)] px-[0.75rem] active:opacity-90"
              onClick={() => {
                onCreate();
                closeDrawer();
              }}
            >
              <Text className="at-icon at-icon-add text-[0.875rem] leading-none text-[var(--lb-on-accent)] [&::before]:block" />
              <Text className="text-[0.875rem] font-semibold leading-none text-[var(--lb-on-accent)]">
                发起新对话
              </Text>
            </View>
            <View
              className="flex min-h-[2.75rem] items-center justify-between rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[0.75rem] active:bg-[var(--lb-surface-hover)]"
              onClick={() => {
                onOpenAgents();
                closeDrawer();
              }}
            >
              <View className="flex items-center gap-[0.625rem]">
                <Text className="at-icon at-icon-lightning-bolt text-[0.875rem] leading-none text-[var(--lb-text-secondary)] [&::before]:block" />
                <Text className="text-[0.875rem] font-medium leading-none text-[var(--lb-text-primary)]">
                  查看智能体
                </Text>
              </View>
              <Text className="at-icon at-icon-chevron-right text-[0.75rem] leading-none text-[var(--lb-text-muted)] [&::before]:block" />
            </View>
          </View>

          <View className="mt-[1.25rem]">
            <View className="mb-[0.25rem] flex items-center justify-between px-[0.375rem]">
              <Text className="text-[0.8125rem] font-semibold leading-none text-[var(--lb-text-primary)]">
                历史对话
              </Text>
              <Text className="text-[0.6875rem] leading-none text-[var(--lb-text-muted)]">
                {conversations.length} 个会话
              </Text>
            </View>

            {groups.length === 0 ? (
              <Text className="block px-[0.375rem] pt-[1rem] text-[0.8125rem] leading-[1.5] text-[var(--lb-text-muted)]">
                还没有历史会话，发起一段新对话开始吧。
              </Text>
            ) : (
              groups.map((group) => (
                <View key={group.label} className="mt-[0.625rem]">
                  <Text className="block px-[0.375rem] py-[0.375rem] text-[0.6875rem] font-medium leading-none text-[var(--lb-text-muted)]">
                    {group.label}
                  </Text>
                  {group.items.map((conversation) => {
                    const activeConversation = conversation.id === currentId;
                    const lastMessage =
                      conversation.messages[conversation.messages.length - 1];
                    const preview = lastMessage
                      ? lastMessage.content.replace(/\s+/g, " ").slice(0, 30)
                      : "";

                    return (
                      <View
                        key={conversation.id}
                        className={`mb-[0.125rem] flex min-h-[3.25rem] items-center gap-[0.5rem] rounded-[var(--lb-radius-sm)] px-[0.5rem] py-[0.375rem] ${
                          activeConversation
                            ? "bg-[var(--lb-accent-soft)]"
                            : "active:bg-[var(--lb-surface-hover)]"
                        }`}
                        onClick={() => {
                          onSelect(conversation.id);
                          closeDrawer();
                        }}
                      >
                        <ConversationAvatar
                          conversation={conversation}
                          agents={agents}
                        />
                        <View className="min-w-0 flex-1">
                          <Text
                            className={`${appTextTruncateClass} block text-[0.8125rem] leading-[1.35] ${
                              activeConversation
                                ? "font-semibold text-[var(--lb-accent-ink)]"
                                : "text-[var(--lb-text-primary)]"
                            }`}
                          >
                            {conversation.title || "新对话"}
                          </Text>
                          {preview ? (
                            <Text
                              className={`${appTextTruncateClass} mt-[0.125rem] block text-[0.625rem] leading-[1.35] text-[var(--lb-text-muted)]`}
                            >
                              {preview}
                            </Text>
                          ) : null}
                        </View>
                        <Text
                          className="at-icon at-icon-trash shrink-0 p-[0.25rem] text-[0.75rem] leading-none text-[var(--lb-text-muted)] [&::before]:block"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleDelete(conversation);
                          }}
                        />
                      </View>
                    );
                  })}
                </View>
              ))
            )}
          </View>
        </View>

        <View className="border-t border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] px-[0.875rem] pt-[0.5rem] box-border">
          <View
            className="flex min-h-[2.75rem] items-center gap-[0.625rem] active:opacity-70"
            onClick={() => {
              onOpenSettings();
              closeDrawer();
            }}
          >
            <View className="flex h-[2rem] w-[2rem] shrink-0 items-center justify-center rounded-full bg-[var(--lb-accent-soft)]">
              <Text className="text-[0.8125rem] font-semibold leading-none text-[var(--lb-accent-ink)]">
                {accountName.slice(0, 1)}
              </Text>
            </View>
            <View className="min-w-0 flex-1">
              <Text className="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
                {accountName}
              </Text>
              <Text className="mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.625rem] leading-[1.3] text-[var(--lb-text-secondary)]">
                {accountHint}
              </Text>
            </View>
            <Text className="at-icon at-icon-chevron-right text-[0.75rem] leading-none text-[var(--lb-text-muted)] [&::before]:block" />
          </View>
          <View
            className="flex min-h-[2rem] items-center justify-between border-t border-[var(--lb-line-soft)] active:opacity-70"
            onClick={() => {
              onOpenSettings();
              closeDrawer();
            }}
          >
            <Text className="text-[0.6875rem] leading-none text-[var(--lb-text-secondary)]">
              设置
            </Text>
            <Text className="text-[0.625rem] leading-none text-[var(--lb-text-muted)]">
              主题 · 账号与安全 ›
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function ConversationAvatar({
  conversation,
  agents,
}: {
  conversation: Conversation;
  agents: AgentSummary[];
}) {
  const memberIds = conversation.agentIds ?? [];
  const findAvatar = (id: string) =>
    agentAvatarSrc(agents.find((agent) => agent.id === id)?.avatar);

  if (conversation.type === "GROUP" && memberIds.length > 1) {
    return (
      <View className="grid h-[2rem] w-[2rem] shrink-0 grid-cols-2 gap-[0.0625rem] overflow-hidden rounded-[0.5rem] border border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] p-[0.125rem] box-border">
        {memberIds.slice(0, 4).map((id) => (
          <Image
            key={id}
            className="h-full w-full rounded-[0.1875rem] bg-[var(--lb-surface)]"
            src={findAvatar(id)}
            mode="aspectFill"
          />
        ))}
      </View>
    );
  }

  return (
    <Image
      className="h-[2rem] w-[2rem] shrink-0 rounded-[0.5rem] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)]"
      src={agentAvatarSrc(
        memberIds[0]
          ? (agents.find((agent) => agent.id === memberIds[0])?.avatar ?? null)
          : null,
      )}
      mode="aspectFill"
    />
  );
}
