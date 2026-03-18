import { View, Text } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { AtSwipeAction } from "taro-ui";
import TabBar from "../../components/TabBar";
import { useChatStore } from "../../store/chatStore";

const swipeOptions = [{ text: "删除", style: { backgroundColor: "#E34D59" } }];

export default function IndexPage() {
  const {
    conversations,
    loadConversations,
    createConversation,
    deleteConversation,
  } = useChatStore();

  useDidShow(() => {
    loadConversations();
  });

  const handleCreate = async () => {
    const id = await createConversation();
    Taro.navigateTo({ url: `/pages/chat/index?conversationId=${id}` });
  };

  const handleOpen = (id: string) => {
    Taro.navigateTo({ url: `/pages/chat/index?conversationId=${id}` });
  };

  const handleDelete = async (id: string) => {
    await deleteConversation(id);
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${month}/${day} ${hour}:${minute}`;
  };

  const getLastMessage = (conv: Conversation): string => {
    if (conv.messages.length === 0) return "暂无消息";
    const last = conv.messages[conv.messages.length - 1];
    return last.content.slice(0, 30) || "...";
  };

  return (
    <View className='app-page'>
      <View className='app-page__body px-rpx-32 pb-rpx-196'>
        <View className='app-animate-fade-in pb-rpx-24 pt-rpx-40'>
          <Text className='app-section-title'>
            最近会话
          </Text>
          <Text className='app-section-subtitle'>
            左滑可删除，点击继续对话
          </Text>
        </View>

        {conversations.length === 0 ? (
          <View className='app-surface app-animate-fade-in mt-rpx-80 flex flex-col items-center justify-center px-rpx-48 py-rpx-72 text-center'>
            <Text className='mb-rpx-32 text-[120rpx] leading-none'>💬</Text>
            <Text className='text-rpx-28 leading-[1.6] text-td-text-tertiary'>
              还没有对话，点击右下角开始聊天吧
            </Text>
          </View>
        ) : (
          <View className='app-surface overflow-hidden'>
            {conversations.map((conv, index) => (
              <AtSwipeAction
                key={conv.id}
                options={swipeOptions}
                onOpened={() => {}}
                onClick={() => handleDelete(conv.id)}
              >
                {index > 0 && (
                  <View
                    className='hairline-b'
                    style={{ marginLeft: "32rpx" }}
                  />
                )}
                <View
                  className='flex items-center px-rpx-32 py-[13rpx] box-border'
                  onClick={() => handleOpen(conv.id)}
                >
                  <View className='min-w-0 flex-1'>
                    <View className='mb-rpx-4 flex items-center justify-between gap-rpx-16'>
                      <Text className='app-text-truncate min-w-0 flex-1 text-rpx-32 font-semibold leading-[1.3] text-td-text-primary'>
                        {conv.title || "新对话"}
                      </Text>
                      <Text className='shrink-0 text-rpx-24 leading-none text-td-text-tertiary'>
                        {formatTime(conv.updatedAt)}
                      </Text>
                    </View>
                    <Text className='app-text-truncate block text-[26rpx] leading-[1.4] text-td-text-secondary'>
                      {getLastMessage(conv)}
                    </Text>
                  </View>
                  <Text className='at-icon at-icon-chevron-right ml-rpx-16 shrink-0 text-rpx-32 leading-none text-[#C9CDD4] [&::before]:block' />
                </View>
              </AtSwipeAction>
            ))}
          </View>
        )}
      </View>

      <View
        className='app-animate-scale-in fixed bottom-rpx-196 right-rpx-48 z-[100]'
      >
        <View
          className='flex h-rpx-112 w-rpx-112 items-center justify-center box-border rounded-td-xl-rpx border-[1.5rpx] border-white bg-gradient-to-b from-[#1A67FF] to-[#0052D9] shadow-[0_12rpx_28rpx_rgba(0,82,217,0.28)]'
          onClick={handleCreate}
        >
          <Text className='at-icon at-icon-add text-rpx-48 leading-none text-white [&::before]:block' />
        </View>
      </View>

      <TabBar current={0} />
    </View>
  );
}
