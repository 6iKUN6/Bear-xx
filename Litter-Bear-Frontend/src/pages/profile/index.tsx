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
    <View className='flex flex-col min-h-screen bg-td-bg-page'>
      <View className='flex-1 pb-[156rpx]'>
        {/* Avatar & nickname header */}
        <View className='mx-4 mt-4 rounded-td-lg shadow-td-sm overflow-hidden border border-td-border-base bg-white'>
          <View className='flex flex-col items-center pt-[64rpx] pb-[52rpx] px-6 bg-td-bg-soft'>
            {userInfo?.avatarUrl ? (
              <Image
                className='w-[136rpx] h-[136rpx] rounded-full mb-3 border-[3rpx] border-white'
                src={userInfo.avatarUrl}
                mode='aspectFill'
              />
            ) : (
              <View className='w-[136rpx] h-[136rpx] rounded-full mb-3 bg-white border border-td-border-base' />
            )}
            <Text className='text-[38rpx] font-semibold text-td-text-primary'>
              {userInfo?.nickname || "未登录"}
            </Text>
          </View>
        </View>

        {/* Settings group card */}
        <View className='mx-4 mt-4 bg-white rounded-td-lg shadow-td-sm overflow-hidden border border-td-border-base'>
          <View
            className='flex items-center justify-between px-4 py-[28rpx] active:bg-td-bg-secondary transition-colors duration-150'
            onClick={handleClearChat}
          >
            <Text className='text-[32rpx] text-td-text-primary'>清除聊天记录</Text>
            <Text className='at-icon at-icon-chevron-right text-[32rpx] text-td-text-disabled' />
          </View>
          <View className='hairline-b' style={{ marginLeft: "32rpx" }} />
          <View
            className='flex items-center justify-between px-4 py-[28rpx] active:bg-td-bg-secondary transition-colors duration-150'
            onClick={handleLoginOrLogout}
          >
            <Text className={`text-[32rpx] ${isLoggedIn ? "text-td-danger" : "text-td-brand"}`}>
              {isLoggedIn ? "退出登录" : "去登录"}
            </Text>
            <Text className='at-icon at-icon-chevron-right text-[32rpx] text-td-text-disabled' />
          </View>
        </View>
      </View>

      <TabBar current={2} />
    </View>
  );
}
