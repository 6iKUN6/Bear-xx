import { View, Text, Image } from "@tarojs/components";
import Taro from "@tarojs/taro";
import TabBar from "../../components/TabBar";
import { useUserStore } from "../../store/userStore";
import { useChatStore } from "../../store/chatStore";
import { STORAGE_KEYS } from "../../utils/constants";
import * as storage from "../../utils/storage";

export default function ProfilePage() {
  const { userInfo, isLoggedIn, logout } = useUserStore();

  const handleLoginOrLogout = () => {
    if (isLoggedIn) {
      Taro.showModal({
        title: "提示",
        content: "确定退出登录吗？",
        success(res) {
          if (res.confirm) {
            logout();
          }
        },
      });
    } else {
      Taro.redirectTo({ url: "/pages/login/index" });
    }
  };

  const handleClearChat = () => {
    Taro.showModal({
      title: "提示",
      content: "确定清除所有聊天记录吗？此操作不可恢复。",
      success(res) {
        if (res.confirm) {
          storage.remove(STORAGE_KEYS.CONVERSATIONS);
          useChatStore.setState({ conversations: [], currentConversation: null });
          Taro.showToast({ title: "已清除", icon: "success" });
        }
      },
    });
  };

  return (
    <View className='app-page'>
      <View className='app-page__body pb-rpx-196'>
        <View className='app-surface mx-rpx-32 mt-rpx-32 overflow-hidden'>
          <View className='flex flex-col items-center bg-gradient-to-b from-td-bg-soft to-[#F7F9FF] px-rpx-48 pb-rpx-52 pt-rpx-64'>
            {userInfo?.avatarUrl ? (
              <Image
                className='mb-rpx-24 h-[136rpx] w-[136rpx] rounded-td-pill-rpx border-[1.5rpx] border-white box-border'
                src={userInfo.avatarUrl}
                mode='aspectFill'
              />
            ) : (
              <View className='mb-rpx-24 h-[136rpx] w-[136rpx] rounded-td-pill-rpx border-[1.5rpx] border-td-border-base bg-white box-border' />
            )}
            <Text className='text-[38rpx] font-semibold leading-[1.3] text-td-text-primary'>
              {userInfo?.nickname || "未登录"}
            </Text>
          </View>
        </View>

        <View className='app-surface mx-rpx-32 mt-rpx-32 overflow-hidden'>
          <View
            className='flex items-center justify-between gap-rpx-24 px-rpx-32 py-rpx-28 box-border'
            onClick={handleClearChat}
          >
            <Text className='text-rpx-32 leading-[1.4] text-td-text-primary'>清除聊天记录</Text>
            <Text className='at-icon at-icon-chevron-right text-rpx-32 leading-none text-[#C9CDD4] [&::before]:block' />
          </View>
          <View className='hairline-b ml-rpx-32' />
          <View
            className='flex items-center justify-between gap-rpx-24 px-rpx-32 py-rpx-28 box-border'
            onClick={handleLoginOrLogout}
          >
            <Text
              className={`text-rpx-32 leading-[1.4] ${isLoggedIn ? "text-td-danger" : "text-td-brand"}`}
            >
              {isLoggedIn ? "退出登录" : "去登录"}
            </Text>
            <Text className='at-icon at-icon-chevron-right text-rpx-32 leading-none text-[#C9CDD4] [&::before]:block' />
          </View>
        </View>
      </View>

      <TabBar current={2} />
    </View>
  );
}
