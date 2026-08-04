import { useEffect, useState } from "react";
import { View, Text } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import ChatWorkspace from "../../components/ChatWorkspace";
import HistoryDrawer from "../../components/HistoryDrawer";
import { useChatStore } from "../../store/chatStore";
import { appGlassCardStrongClass, appIconTileClass } from "../../utils/style";

const starterPrompts = [
  {
    icon: "✎",
    title: "写一段文案",
    desc: "把想法整理成朋友圈、邮件或小红书草稿",
  },
  {
    icon: "⌁",
    title: "总结长文本",
    desc: "粘贴内容，让小熊提炼重点和行动项",
  },
  {
    icon: "◷",
    title: "规划今天",
    desc: "把零散任务排成一份可执行清单",
  },
  {
    icon: "?",
    title: "随便聊聊",
    desc: "从一个问题开始，慢慢把思路聊清楚",
  },
];

/**
 * 首页 = 最近对话工作台
 * @description 默认直显最近一次会话的内容；左上角按钮打开历史抽屉
 * （今天/昨天/七天内/30天内分组），点击条目原地切换会话。
 */
export default function IndexPage() {
  const {
    conversations,
    currentConversation,
    loadConversations,
    setCurrentConversation,
    clearCurrentConversation,
    deleteConversation,
  } = useChatStore();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useDidShow(() => {
    void loadConversations();
  });

  // 无当前会话（首次进入/当前会话被删）时自动落到最近更新的一条
  useEffect(() => {
    if (currentConversation || conversations.length === 0) {
      return;
    }
    const latest = conversations.reduce((a, b) =>
      a.updatedAt >= b.updatedAt ? a : b,
    );
    setCurrentConversation(latest.id);
  }, [conversations, currentConversation, setCurrentConversation]);

  const historyButton = (
    <View
      className="flex h-[2.5rem] w-[2.5rem] items-center justify-center rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] text-[1.125rem] text-[var(--lb-text-primary)] active:bg-[var(--lb-surface-hover)]"
      onClick={() => setDrawerOpen(true)}
    >
      <Text className="at-icon at-icon-bullet-list leading-none [&::before]:block" />
    </View>
  );

  return (
    <>
      <ChatWorkspace
        navLeft={historyButton}
        renderEmpty={({ setDraft }) => (
          <View className="px-[1rem] pt-[1rem]">
            <View
              className={`${appGlassCardStrongClass} overflow-hidden px-[1.25rem] py-[1.25rem]`}
            >
              <View className="flex items-start gap-[0.875rem]">
                <View
                  className={`${appIconTileClass} h-[3.25rem] w-[3.25rem] shrink-0 text-[1.5rem]`}
                >
                  <Text className="leading-none">✦</Text>
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="block text-[1.125rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]">
                    今天想让小熊帮你做什么？
                  </Text>
                  <Text className="mt-[0.375rem] block text-[0.875rem] leading-[1.55] text-[var(--lb-text-secondary)]">
                    选择一个常用任务填进输入框，或直接开聊。
                  </Text>
                </View>
              </View>

              <View className="mt-[1.125rem] grid grid-cols-2 gap-[0.625rem]">
                {starterPrompts.map((item) => (
                  <View
                    key={item.title}
                    className="rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] px-[0.875rem] py-[0.875rem] active:bg-[var(--lb-surface-hover)]"
                    onClick={() => setDraft(`${item.title}：`)}
                  >
                    <Text className="block text-[1.25rem] leading-none text-[var(--lb-accent-ink)]">
                      {item.icon}
                    </Text>
                    <Text className="mt-[0.625rem] block text-[0.875rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
                      {item.title}
                    </Text>
                    <Text className="mt-[0.25rem] block text-[0.75rem] leading-[1.45] text-[var(--lb-text-secondary)]">
                      {item.desc}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
        )}
      />

      <HistoryDrawer
        open={drawerOpen}
        conversations={conversations}
        currentId={currentConversation?.id ?? null}
        onSelect={setCurrentConversation}
        onCreate={clearCurrentConversation}
        onOpenAgents={() => {
          void Taro.navigateTo({ url: "/pages/agents/index" });
        }}
        onOpenSettings={() => {
          void Taro.navigateTo({ url: "/pages/profile/index" });
        }}
        onDelete={(id) => {
          void deleteConversation(id);
        }}
        onClose={() => setDrawerOpen(false)}
      />
    </>
  );
}
