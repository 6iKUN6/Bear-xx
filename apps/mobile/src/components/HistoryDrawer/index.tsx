import { useEffect, useState } from "react";
import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import AppIcon from "../AppIcon";
import { useNavBarMetrics } from "../../hooks/useNavBarMetrics";
import { useUserStore } from "../../store/userStore";
import { groupConversationsByTime } from "../../utils/conversation";
import { appTextTruncateClass } from "../../utils/style";

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
        {/* 头部：品牌块 + 名称 */}
        <View className="flex items-center gap-[0.625rem] px-[1rem] pb-[0.875rem] pt-[1.125rem]">
          <View className="flex h-[2rem] w-[2rem] shrink-0 items-center justify-center rounded-[var(--lb-radius-sm)] bg-[var(--lb-accent-surface)]">
            <Text className="text-[0.9375rem] font-bold leading-none text-[var(--lb-on-accent)]">
              办
            </Text>
          </View>
          <View className="min-w-0 flex-1">
            <Text className="block text-[0.9375rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
              办伴
            </Text>
            <Text className="mt-[0.125rem] block text-[0.6875rem] leading-none text-[var(--lb-text-muted)]">
              Banban · AI 工作台
            </Text>
          </View>
          <View
            className="flex h-[2.25rem] w-[2.25rem] shrink-0 items-center justify-center rounded-[var(--lb-radius-sm)] text-[var(--lb-text-secondary)] active:bg-[var(--lb-surface-hover)]"
            onClick={closeDrawer}
          >
            <AppIcon name="close" className="h-[1rem] w-[1rem]" />
          </View>
        </View>

        {/* 操作行：新对话 + 智能体入口 */}
        <View className="flex gap-[0.5rem] px-[1rem] pb-[0.75rem]">
          <View
            className="flex h-[2.5rem] min-w-0 flex-1 items-center justify-center gap-[0.375rem] rounded-[var(--lb-radius-sm)] bg-[var(--lb-accent-surface)] active:opacity-90"
            onClick={() => {
              onCreate();
              closeDrawer();
            }}
          >
            <AppIcon name="plus" className="h-[0.875rem] w-[0.875rem] text-[var(--lb-on-accent)]" />
            <Text className="text-[0.8125rem] font-semibold leading-none text-[var(--lb-on-accent)]">
              发起新对话
            </Text>
          </View>
          <View
            className="flex h-[2.5rem] shrink-0 items-center justify-center gap-[0.375rem] rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] px-[0.875rem] active:bg-[var(--lb-surface-hover)]"
            onClick={() => {
              onOpenAgents();
              closeDrawer();
            }}
          >
            <AppIcon name="zap" className="h-[0.875rem] w-[0.875rem] text-[var(--lb-text-secondary)]" />
            <Text className="text-[0.8125rem] font-medium leading-none text-[var(--lb-text-primary)]">
              智能体
            </Text>
          </View>
        </View>

        {/* 会话列表：按时间分组，当前会话高亮 */}
        <View className="min-h-0 flex-1 overflow-y-auto px-[0.625rem] pb-[0.75rem]">
          {groups.length === 0 ? (
            <Text className="block px-[0.375rem] pt-[1rem] text-[0.8125rem] leading-[1.5] text-[var(--lb-text-muted)]">
              还没有历史会话，发起一段新对话开始吧。
            </Text>
          ) : (
            groups.map((group) => (
              <View key={group.label}>
                <Text className="block px-[0.375rem] pb-[0.375rem] pt-[0.75rem] text-[0.6875rem] leading-none text-[var(--lb-text-muted)]">
                  {group.label}
                </Text>
                {group.items.map((conversation) => {
                  const activeConversation = conversation.id === currentId;

                  return (
                    <View
                      key={conversation.id}
                      className={`box-border flex min-h-[2.75rem] w-full items-center gap-[0.5rem] rounded-[var(--lb-radius-sm)] px-[0.625rem] py-[0.625rem] ${
                        activeConversation
                          ? "bg-[var(--lb-accent-soft)]"
                          : "active:bg-[var(--lb-surface-hover)]"
                      }`}
                      onClick={() => {
                        onSelect(conversation.id);
                        closeDrawer();
                      }}
                    >
                      <Text
                        className={`${appTextTruncateClass} min-w-0 flex-1 text-[0.8125rem] leading-[1.35] ${
                          activeConversation
                            ? "font-semibold text-[var(--lb-accent-ink)]"
                            : "text-[var(--lb-text-primary)]"
                        }`}
                      >
                        {conversation.title || "新对话"}
                      </Text>
                      <View
                        className="flex h-[1.75rem] w-[1.75rem] shrink-0 items-center justify-center rounded-[var(--lb-radius-xs)] text-[var(--lb-text-muted)] active:bg-[var(--lb-danger-soft)] active:text-[var(--lb-danger)]"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDelete(conversation);
                        }}
                      >
                        <AppIcon name="trash" className="h-[0.75rem] w-[0.75rem]" />
                      </View>
                    </View>
                  );
                })}
              </View>
            ))
          )}
        </View>

        {/* 底部账户区 */}
        <View
          className="flex items-center gap-[0.625rem] border-t border-[var(--lb-line-soft)] px-[1rem] pt-[0.625rem] box-border"
          style={{
            paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom))",
          }}
        >
          <View
            className="flex min-w-0 flex-1 items-center gap-[0.625rem] active:opacity-70"
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
              <Text className="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
                {accountName}
              </Text>
              <Text className="mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] leading-[1.3] text-[var(--lb-text-muted)]">
                {accountHint}
              </Text>
            </View>
          </View>
          <View
            className="flex h-[2.25rem] w-[2.25rem] shrink-0 items-center justify-center rounded-[var(--lb-radius-sm)] text-[var(--lb-text-secondary)] active:bg-[var(--lb-surface-hover)]"
            onClick={() => {
              onOpenSettings();
              closeDrawer();
            }}
          >
            <AppIcon name="settings" className="h-[1.125rem] w-[1.125rem]" />
          </View>
        </View>
      </View>
    </View>
  );
}
