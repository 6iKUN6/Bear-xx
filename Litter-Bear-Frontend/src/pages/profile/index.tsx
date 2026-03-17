import { View, Text, Image } from "@tarojs/components";
import Taro from "@tarojs/taro";
import TabBar from "../../components/TabBar";
import { useUserStore } from "../../store/userStore";
import { useChatStore } from "../../store/chatStore";
import { STORAGE_KEYS } from "../../utils/constants";
import * as storage from "../../utils/storage";
import { rpx } from "../../utils/style";
import "./index.scss";

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
    <View className='app-page profile-page'>
      <View className='app-page__body profile-page__body'>
        <View className='app-surface profile-page__hero'>
          <View className='profile-page__hero-header'>
            {userInfo?.avatarUrl ? (
              <Image
                className='profile-page__avatar'
                src={userInfo.avatarUrl}
                mode='aspectFill'
              />
            ) : (
              <View className='profile-page__avatar profile-page__avatar--placeholder' />
            )}
            <Text className='profile-page__nickname'>
              {userInfo?.nickname || "未登录"}
            </Text>
          </View>
        </View>

        <View className='app-surface profile-page__settings'>
          <View
            className='profile-page__setting-item'
            onClick={handleClearChat}
          >
            <Text className='profile-page__setting-label'>清除聊天记录</Text>
            <Text className='profile-page__setting-arrow at-icon at-icon-chevron-right' />
          </View>
          <View className='hairline-b' style={{ marginLeft: rpx(32) }} />
          <View
            className='profile-page__setting-item'
            onClick={handleLoginOrLogout}
          >
            <Text
              className={`profile-page__setting-label ${isLoggedIn ? "profile-page__setting-label--danger" : "profile-page__setting-label--brand"}`}
            >
              {isLoggedIn ? "退出登录" : "去登录"}
            </Text>
            <Text className='profile-page__setting-arrow at-icon at-icon-chevron-right' />
          </View>
        </View>
      </View>

      <TabBar current={2} />
    </View>
  );
}
