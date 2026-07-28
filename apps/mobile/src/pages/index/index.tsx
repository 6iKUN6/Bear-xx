import { View, Text } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { AtSwipeAction } from "taro-ui";
import TabBar from "../../components/TabBar";
import TabPageTopInset from "../../components/TabPageTopInset";
import PageShell from "../../components/PageShell";
import { useChatStore } from "../../store/chatStore";
import {
  appGlassCardClass,
  appGlassCardStrongClass,
  appGradientSurfaceClass,
  appHeroClass,
  appHeroSubtitleClass,
  appHeroTitleClass,
  appIconTileClass,
  appScreenClass,
  appShellFixedClass,
  appTextTruncateClass,
} from "../../utils/style";

const SWIPE_ACTION_WIDTH = 84;

const swipeOptions = [
  {
    text: "删除",
    style: {
      width: `${SWIPE_ACTION_WIDTH}px`,
      padding: 0,
      backgroundColor: "var(--lb-danger)",
      color: "var(--lb-on-accent)",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: "15px",
      fontWeight: 600,
    },
  },
];

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

export default function IndexPage() {
  const { conversations, loadConversations, deleteConversation } =
    useChatStore();

  useDidShow(() => {
    loadConversations();
  });

  const handleCreate = async () => {
    Taro.navigateTo({ url: "/pages/chat/index" });
  };

  const handleOpen = (id: string) => {
    Taro.navigateTo({ url: `/pages/chat/index?conversationId=${id}` });
  };

  const handleDelete = async (id: string) => {
    await deleteConversation(id);
  };

  const formatTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    if (diff < hour) return "刚刚";
    if (diff < day) return `${Math.max(1, Math.floor(diff / hour))}小时前`;
    if (diff < day * 2) return "昨天";
    return `${Math.max(2, Math.floor(diff / day))}天前`;
  };

  const getLastMessage = (conv: Conversation): string => {
    if (conv.messages.length === 0) return "点击开始你的第一次对话";
    const last = conv.messages[conv.messages.length - 1];
    return last.content.replace(/\s+/g, " ").slice(0, 36) || "继续对话";
  };

  return (
    <PageShell>
      <TabPageTopInset />
      <View className={appScreenClass}>
        <View className={`${appHeroClass} pt-[0.875rem]`}>
          <Text className={appHeroTitleClass}>最近会话</Text>
          <Text className={appHeroSubtitleClass}>继续未完成的对话</Text>
        </View>

        {conversations.length === 0 ? (
          <View className="px-[1rem] pt-[0.5rem]">
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
                    选择一个常用任务，或直接新建对话。
                  </Text>
                </View>
              </View>

              <View className="mt-[1.125rem] grid grid-cols-2 gap-[0.625rem]">
                {starterPrompts.map((item) => (
                  <View
                    key={item.title}
                    className="rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] px-[0.875rem] py-[0.875rem] active:bg-[var(--lb-surface-hover)]"
                    onClick={handleCreate}
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
        ) : (
          <View className="box-border w-full max-w-full overflow-hidden px-[1rem] pt-[0.75rem]">
            {conversations.map((conv, index) => (
              <View
                key={conv.id}
                className={`w-full max-w-full ${
                  index > 0 ? "mt-[0.75rem]" : ""
                }`}
              >
                <AtSwipeAction
                  className="lb-swipe-action w-full max-w-full"
                  options={swipeOptions}
                  onOpened={() => {}}
                  onClick={() => handleDelete(conv.id)}
                >
                  <View
                    className={`${appGlassCardClass} box-border w-full overflow-hidden active:scale-[0.98]`}
                    onClick={() => handleOpen(conv.id)}
                  >
                    <View className="box-border flex w-full max-w-full min-w-0 items-start gap-[0.875rem] overflow-hidden px-[1rem] py-[1rem]">
                      <View
                        className={`${appIconTileClass} h-[2.625rem] w-[2.625rem] shrink-0 text-[1.0625rem]`}
                      >
                        <Text className="leading-none">✧</Text>
                      </View>

                      <View className="min-w-0 flex-1 overflow-hidden">
                        <View className="mb-[0.375rem] flex min-w-0 max-w-full items-center justify-between gap-[0.625rem] overflow-hidden">
                          <Text
                            className={`${appTextTruncateClass} block min-w-0 flex-1 text-[1rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]`}
                          >
                            {conv.title || "新对话"}
                          </Text>
                          <Text className="block max-w-[3rem] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-right text-[0.8125rem] leading-none text-[var(--lb-text-muted)]">
                            {formatTime(conv.updatedAt)}
                          </Text>
                        </View>
                        <Text
                          className={`${appTextTruncateClass} block w-full max-w-full text-[0.875rem] leading-[1.45] text-[var(--lb-text-secondary)]`}
                        >
                          {getLastMessage(conv)}
                        </Text>
                      </View>

                      <Text className="at-icon at-icon-chevron-right mt-[0.625rem] shrink-0 text-[0.875rem] leading-none text-[var(--lb-text-muted)] [&::before]:block" />
                    </View>
                  </View>
                </AtSwipeAction>
              </View>
            ))}
          </View>
        )}
      </View>

      <View
        className={`${appShellFixedClass} bottom-[calc(env(safe-area-inset-bottom)+4.375rem)] z-40 flex justify-end pr-[1.5rem] pointer-events-none`}
      >
        <View
          className={`${appGradientSurfaceClass} pointer-events-auto flex h-[3.5rem] w-[3.5rem] items-center justify-center rounded-[var(--lb-radius-md)] shadow-[var(--lb-shadow-glow)] active:scale-95`}
          onClick={handleCreate}
        >
          <Text className="at-icon at-icon-add text-[1.75rem] leading-none text-[var(--lb-on-accent)] [&::before]:block" />
        </View>
      </View>

      <TabBar current={0} />
    </PageShell>
  );
}
