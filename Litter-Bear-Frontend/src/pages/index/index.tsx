import { View, Text } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { AtSwipeAction } from "taro-ui";
import TabBar from "../../components/TabBar";
import { useChatStore } from "../../store/chatStore";
import { rpx } from "../../utils/style";
import "./index.scss";

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
    <View className='app-page home-page'>
      <View className='app-page__body home-page__body'>
        <View className='home-page__header app-animate-fade-in'>
          <Text className='app-section-title'>
            最近会话
          </Text>
          <Text className='app-section-subtitle'>
            左滑可删除，点击继续对话
          </Text>
        </View>

        {conversations.length === 0 ? (
          <View className='app-surface home-page__empty app-animate-fade-in'>
            <Text className='home-page__empty-icon'>💬</Text>
            <Text className='home-page__empty-text'>
              还没有对话，点击右下角开始聊天吧
            </Text>
          </View>
        ) : (
          <View className='app-surface home-page__list'>
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
                    style={{ marginLeft: rpx(32) }}
                  />
                )}
                <View
                  className='home-page__item'
                  onClick={() => handleOpen(conv.id)}
                >
                  <View className='home-page__item-main'>
                    <View className='home-page__item-head'>
                      <Text className='home-page__item-title app-text-truncate'>
                        {conv.title || "新对话"}
                      </Text>
                      <Text className='home-page__item-time'>
                        {formatTime(conv.updatedAt)}
                      </Text>
                    </View>
                    <Text className='home-page__item-preview app-text-truncate'>
                      {getLastMessage(conv)}
                    </Text>
                  </View>
                  <Text className='home-page__item-arrow at-icon at-icon-chevron-right' />
                </View>
              </AtSwipeAction>
            ))}
          </View>
        )}
      </View>

      <View
        className='home-page__fab app-animate-scale-in'
        style={{ bottom: rpx(196) }}
      >
        <View
          className='home-page__fab-button'
          onClick={handleCreate}
        >
          <Text className='home-page__fab-icon at-icon at-icon-add' />
        </View>
      </View>

      <TabBar current={0} />
    </View>
  );
}
