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

const swipeOptions = [{ text: "删除", style: { backgroundColor: "#dc2626" } }];

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
          <View className="px-[1.5rem] pt-[3rem]">
            <View className={`${appGlassCardStrongClass} flex flex-col items-center px-[2rem] py-[3rem] text-center`}>
              <View className="mb-[1.5rem] animate-app-float">
                <View className={`${appIconTileClass} h-[5rem] w-[5rem] rounded-[1.5rem] text-[2.625rem] shadow-[0_1.125rem_2.625rem_rgba(124,58,237,0.24)]`}>
                  <Text className="leading-none">💬</Text>
                </View>
              </View>
              <Text className="mb-[0.5rem] block text-[1.125rem] font-semibold leading-[1.4] text-[var(--lb-text-primary)]">
                还没有对话记录
              </Text>
              <Text className="block text-[0.9375rem] leading-[1.7] text-[var(--lb-text-secondary)]">
                点击右下角开始你的第一次对话
              </Text>
            </View>
          </View>
        ) : (
          <View className="px-[1rem] pt-[0.5rem]">
            {conversations.map((conv, index) => (
              <View key={conv.id} className={index > 0 ? "mt-[0.75rem]" : ""}>
                <AtSwipeAction
                  options={swipeOptions}
                  onOpened={() => {}}
                  onClick={() => handleDelete(conv.id)}
                >
                  <View
                    className={`${appGlassCardClass} overflow-hidden active:scale-[0.98]`}
                    onClick={() => handleOpen(conv.id)}
                  >
                    <View className="flex items-start gap-[0.875rem] px-[1.125rem] py-[1.125rem] box-border">
                      <View className={`${appIconTileClass} h-[2.75rem] w-[2.75rem] shrink-0 text-[1.125rem] shadow-[0_0.625rem_1.375rem_rgba(236,72,153,0.24)]`}>
                        <Text className="leading-none">✧</Text>
                      </View>

                      <View className="min-w-0 flex-1">
                        <View className="mb-[0.375rem] flex items-center justify-between gap-[0.625rem]">
                          <Text className={`${appTextTruncateClass} min-w-0 flex-1 text-[1.0625rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]`}>
                            {conv.title || "新对话"}
                          </Text>
                          <Text className="shrink-0 text-[0.8125rem] leading-none text-[var(--lb-text-muted)]">
                            {formatTime(conv.updatedAt)}
                          </Text>
                        </View>
                        <Text className={`${appTextTruncateClass} block text-[0.9375rem] leading-[1.45] text-[var(--lb-text-secondary)]`}>
                          {getLastMessage(conv)}
                        </Text>
                      </View>

                      <Text className="at-icon at-icon-chevron-right mt-[0.625rem] shrink-0 text-[0.9375rem] leading-none text-[var(--lb-text-muted)] [&::before]:block" />
                    </View>
                  </View>
                </AtSwipeAction>
              </View>
            ))}
          </View>
        )}
      </View>

      <View className={`${appShellFixedClass} bottom-[calc(env(safe-area-inset-bottom)+4.375rem)] z-40 flex justify-end pr-[1.5rem] pointer-events-none`}>
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
