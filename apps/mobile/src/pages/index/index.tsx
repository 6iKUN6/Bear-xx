import { View, Text } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { AtSwipeAction } from "taro-ui";
import TabBar from "../../components/TabBar";
import TabPageTopInset from "../../components/TabPageTopInset";
import { useChatStore } from "../../store/chatStore";
import {
  appGlassCardClass,
  appGlassCardStrongClass,
  appGradientSurfaceClass,
  appHeroClass,
  appHeroSubtitleClass,
  appHeroTitleClass,
  appIconTileClass,
  appPageClass,
  appScreenClass,
  appShellFixedClass,
  appTextTruncateClass,
} from "../../utils/style";

const SWIPE_ACTION_WIDTH = 84;
const CONVERSATION_CARD_INSET = "1rem";
const CONVERSATION_CARD_OUTER_PADDING = "1rem";

const swipeOptions = [
  {
    text: "删除",
    style: {
      width: `${SWIPE_ACTION_WIDTH}px`,
      padding: 0,
      backgroundColor: "#e11d48",
      color: "#ffffff",
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
    <View className={appPageClass}>
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
                  className={`${appIconTileClass} h-[3.25rem] w-[3.25rem] shrink-0 rounded-[1rem] text-[1.5rem] shadow-[0_0.75rem_1.75rem_rgba(124,58,237,0.22)]`}
                >
                  <Text className="leading-none">✦</Text>
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="block text-[1.125rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]">
                    今天想让小熊帮你做什么？
                  </Text>
                  <Text className="mt-[0.375rem] block text-[0.875rem] leading-[1.55] text-[var(--lb-text-secondary)]">
                    选一个入口开始，也可以直接点右下角新建对话。
                  </Text>
                </View>
              </View>

              <View className="mt-[1.125rem] grid grid-cols-2 gap-[0.625rem]">
                {starterPrompts.map((item) => (
                  <View
                    key={item.title}
                    className="rounded-[1rem] border border-[rgba(196,181,253,0.22)] bg-white/80 px-[0.875rem] py-[0.875rem]"
                    onClick={handleCreate}
                  >
                    <Text className="block text-[1.25rem] leading-none text-[var(--lb-grad-a)]">
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
          <View className="box-border w-full max-w-full overflow-hidden pt-[0.75rem]">
            {conversations.map((conv, index) => (
              <View
                key={conv.id}
                className={`w-full max-w-full overflow-hidden ${
                  index > 0 ? "mt-[0.75rem]" : ""
                }`}
              >
                <AtSwipeAction
                  className="w-full max-w-full overflow-hidden"
                  options={swipeOptions}
                  onOpened={() => {}}
                  onClick={() => handleDelete(conv.id)}
                >
                  <View
                    className="box-border w-screen max-w-none overflow-hidden"
                    onClick={() => handleOpen(conv.id)}
                  >
                    <View
                      className={`${appGlassCardClass} overflow-hidden active:scale-[0.98]`}
                      style={{
                        marginLeft: CONVERSATION_CARD_INSET,
                        width: `calc(100vw - ${CONVERSATION_CARD_INSET} - ${CONVERSATION_CARD_OUTER_PADDING})`,
                      }}
                    >
                      <View className="box-border flex w-full max-w-full min-w-0 items-start gap-[0.875rem] overflow-hidden px-[1rem] py-[1rem]">
                        <View
                          className={`${appIconTileClass} h-[2.625rem] w-[2.625rem] shrink-0 text-[1.0625rem] shadow-[0_0.625rem_1.375rem_rgba(236,72,153,0.24)]`}
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
          className={`${appGradientSurfaceClass} pointer-events-auto flex h-[4rem] w-[4rem] animate-app-fab-pulse items-center justify-center rounded-[1.25rem]`}
          onClick={handleCreate}
        >
          <Text className="at-icon at-icon-add text-[1.75rem] leading-none text-white [&::before]:block" />
        </View>
      </View>

      <TabBar current={0} />
    </View>
  );
}
