import { View, Text } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { AtSwipeAction } from "taro-ui";
import TabBar from "../../components/TabBar";
import { useChatStore } from "../../store/chatStore";

const swipeOptions = [
  { text: "删除", style: { backgroundColor: "#E34D59" } },
];

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
    <View className='flex flex-col min-h-screen bg-td-bg-page'>
      <View className='flex-1 px-4 pb-[156rpx]'>
        <View className='pt-5 pb-3 animate-fade-in'>
          <Text className='text-[46rpx] font-semibold text-td-text-primary block'>
            最近会话
          </Text>
          <Text className='text-[24rpx] text-td-text-tertiary mt-[8rpx] block'>
            左滑可删除，点击继续对话
          </Text>
        </View>

        {conversations.length === 0 ? (
          <View className='mt-[80rpx] py-[72rpx] px-6 bg-white rounded-td-lg border border-td-border-base shadow-td-sm flex flex-col items-center justify-center animate-fade-in'>
            <Text className='text-[120rpx] mb-4'>💬</Text>
            <Text className='text-[28rpx] text-td-text-tertiary text-center'>
              还没有对话，点击右下角开始聊天吧
            </Text>
          </View>
        ) : (
          <View className='bg-white rounded-td-lg shadow-td-sm overflow-hidden border border-td-border-base'>
            {conversations.map((conv, index) => (
              <AtSwipeAction
                key={conv.id}
                options={swipeOptions}
                onOpened={() => {}}
                onClick={() => handleDelete(conv.id)}
              >
                {index > 0 && (
                  <View className='hairline-b' style={{ marginLeft: "32rpx" }} />
                )}
                <View
                  className='flex items-center px-4 py-[26rpx] active:bg-td-bg-secondary transition-colors duration-150'
                  onClick={() => handleOpen(conv.id)}
                >
                  <View className='flex-1 min-w-0'>
                    <View className='flex items-center justify-between mb-1'>
                      <Text className='text-[32rpx] font-medium text-td-text-primary truncate'>
                        {conv.title || "新对话"}
                      </Text>
                      <Text className='text-[24rpx] text-td-text-tertiary ml-2 flex-shrink-0'>
                        {formatTime(conv.updatedAt)}
                      </Text>
                    </View>
                    <Text className='text-[26rpx] text-td-text-secondary truncate block'>
                      {getLastMessage(conv)}
                    </Text>
                  </View>
                  <Text className='at-icon at-icon-chevron-right text-[32rpx] text-td-text-disabled ml-2 flex-shrink-0' />
                </View>
              </AtSwipeAction>
            ))}
          </View>
        )}
      </View>

      {/* FAB */}
      <View
        className='fixed right-6 z-[100] animate-scale-in'
        style={{ bottom: "196rpx" }}
      >
        <View
          className='w-[112rpx] h-[112rpx] rounded-td-xl bg-td-brand shadow-td flex items-center justify-center border-[3rpx] border-white active:scale-95 transition-transform duration-150'
          onClick={handleCreate}
        >
          <Text className='at-icon at-icon-add text-[48rpx] text-white' />
        </View>
      </View>

      <TabBar current={0} />
    </View>
  );
}
