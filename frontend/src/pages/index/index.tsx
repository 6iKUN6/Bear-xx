import { View, Text } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { AtSwipeAction } from "taro-ui";
import TabBar from "../../components/TabBar";
import { useChatStore } from "../../store/chatStore";

const swipeOptions = [{ text: "删除", style: { backgroundColor: "#dc2626" } }];

export default function IndexPage() {
  const {
    conversations,
    loadConversations,
    deleteConversation,
  } = useChatStore();

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
    <View className='app-page'>
      <View className='app-screen'>
        <View className='app-hero pt-[44px]'>
          <Text className='app-hero-title'>最近会话</Text>
          <Text className='app-hero-subtitle'>继续未完成的对话</Text>
        </View>

        {conversations.length === 0 ? (
          <View className='px-[24px] pt-[48px]'>
            <View className='app-glass-card-strong flex flex-col items-center px-[32px] py-[48px] text-center'>
              <View className='app-float mb-[24px]'>
                <View className='app-icon-tile h-[80px] w-[80px] rounded-[24px] text-[42px] shadow-[0_18px_42px_rgba(124,58,237,0.24)]'>
                  <Text className='leading-none'>💬</Text>
                </View>
              </View>
              <Text className='mb-[8px] block text-[18px] font-semibold leading-[1.4] text-[var(--lb-text-primary)]'>
                还没有对话记录
              </Text>
              <Text className='block text-[15px] leading-[1.7] text-[var(--lb-text-secondary)]'>
                点击右下角开始你的第一次对话
              </Text>
            </View>
          </View>
        ) : (
          <View className='px-[16px] pt-[8px]'>
            {conversations.map((conv, index) => (
              <View key={conv.id} className={index > 0 ? "mt-[12px]" : ""}>
                <AtSwipeAction
                  options={swipeOptions}
                  onOpened={() => {}}
                  onClick={() => handleDelete(conv.id)}
                >
                  <View
                    className='app-glass-card overflow-hidden active:scale-[0.98]'
                    onClick={() => handleOpen(conv.id)}
                  >
                    <View className='flex items-start gap-[14px] px-[18px] py-[18px] box-border'>
                      <View className='app-icon-tile h-[44px] w-[44px] shrink-0 text-[18px] shadow-[0_10px_22px_rgba(236,72,153,0.24)]'>
                        <Text className='leading-none'>✧</Text>
                      </View>

                      <View className='min-w-0 flex-1'>
                        <View className='mb-[6px] flex items-center justify-between gap-[10px]'>
                          <Text className='app-text-truncate min-w-0 flex-1 text-[17px] font-semibold leading-[1.35] text-[var(--lb-text-primary)]'>
                            {conv.title || "新对话"}
                          </Text>
                          <Text className='shrink-0 text-[13px] leading-none text-[var(--lb-text-muted)]'>
                            {formatTime(conv.updatedAt)}
                          </Text>
                        </View>
                        <Text className='app-text-truncate block text-[15px] leading-[1.45] text-[var(--lb-text-secondary)]'>
                          {getLastMessage(conv)}
                        </Text>
                      </View>

                      <Text className='at-icon at-icon-chevron-right mt-[10px] shrink-0 text-[15px] leading-none text-[var(--lb-text-muted)] [&::before]:block' />
                    </View>
                  </View>
                </AtSwipeAction>
              </View>
            ))}
          </View>
        )}
      </View>

      <View
        className='fixed bottom-[96px] right-[24px] z-[40]'
      >
        <View
          className='app-gradient-surface app-fab-pulse flex h-[64px] w-[64px] items-center justify-center rounded-[20px]'
          onClick={handleCreate}
        >
          <Text className='at-icon at-icon-add text-[28px] leading-none text-white [&::before]:block' />
        </View>
      </View>

      <TabBar current={0} />
    </View>
  );
}
