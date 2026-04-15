import { View, Text, Image } from "@tarojs/components";
import Taro from "@tarojs/taro";
import TabBar from "../../components/TabBar";
import { useUserStore } from "../../store/userStore";
import { useChatStore } from "../../store/chatStore";
import { STORAGE_KEYS } from "../../utils/constants";
import * as storage from "../../utils/storage";

const settingCards = [
  { icon: "⚙️", label: "通用设置", gradient: "from-[#3b82f6] to-[#06b6d4]" },
  { icon: "🌙", label: "外观主题", gradient: "from-[#4f46e5] to-[#7c3aed]" },
  { icon: "🔔", label: "通知设置", gradient: "from-[#7c3aed] to-[#ec4899]" },
  { icon: "❓", label: "帮助中心", gradient: "from-[#ec4899] to-[#f43f5e]" },
];

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
      return;
    }

    Taro.redirectTo({ url: "/pages/login/index" });
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
      <View className='app-screen'>
        <View className='px-[16px] pb-[8px] pt-[34px]'>
          <View className='app-glass-card-strong relative overflow-hidden'>
            <View className='absolute inset-0 bg-gradient-to-br from-[rgba(124,58,237,0.1)] via-[rgba(236,72,153,0.1)] to-[rgba(79,70,229,0.1)]' />

            <View className='relative flex items-center px-[24px] py-[28px]'>
              <View className='relative'>
                {userInfo?.avatarUrl ? (
                  <Image
                    className='h-[80px] w-[80px] rounded-[24px] border-2 border-white box-border shadow-[0_20px_40px_rgba(124,58,237,0.18)]'
                    src={userInfo.avatarUrl}
                    mode='aspectFill'
                  />
                ) : (
                  <View className='app-icon-tile h-[64px] w-[64px] rounded-[18px] text-[28px] shadow-[0_14px_28px_rgba(236,72,153,0.24)]'>
                    <Text className='leading-none'>🐻</Text>
                  </View>
                )}

                {isLoggedIn && (
                  <View className='app-gradient-surface-warm absolute -bottom-[4px] -right-[4px] flex h-[24px] w-[24px] items-center justify-center rounded-full border-2 border-white text-[12px] shadow-[0_8px_20px_rgba(251,146,60,0.24)]'>
                    <Text className='leading-none'>◔</Text>
                  </View>
                )}
              </View>

              <View className='ml-[18px] min-w-0 flex-1'>
                <Text className='block text-[22px] font-bold leading-[1.2] text-[var(--lb-text-primary)]'>
                  {isLoggedIn ? userInfo?.nickname || "小熊用户" : "未登录"}
                </Text>
                {isLoggedIn && (
                  <View className='mt-[10px] inline-flex rounded-full app-gradient-surface px-[12px] py-[6px] shadow-[0_8px_18px_rgba(124,58,237,0.18)]'>
                    <Text className='text-[12px] font-semibold leading-none text-white'>Pro 会员</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </View>

        {isLoggedIn && (
          <View className='px-[16px] pb-[8px] pt-[10px]'>
            <Text className='mb-[14px] block px-[8px] text-[16px] font-semibold leading-[1.3] text-[var(--lb-text-primary)]'>
              快捷设置
            </Text>
            <View className='grid grid-cols-2 gap-[12px]'>
              {settingCards.map((item) => (
                <View key={item.label} className='app-glass-card px-[16px] py-[16px]'>
                  <View className={`mb-[12px] flex h-[42px] w-[42px] items-center justify-center rounded-[14px] bg-gradient-to-br ${item.gradient} text-[18px] text-white shadow-[0_10px_20px_rgba(124,58,237,0.16)]`}>
                    <Text className='leading-none'>{item.icon}</Text>
                  </View>
                  <Text className='block text-[14px] font-medium leading-[1.4] text-[var(--lb-text-primary)]'>
                    {item.label}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View className='px-[16px] pt-[14px]'>
          <View className='app-glass-card overflow-hidden'>
            {isLoggedIn && (
              <>
                <View
                  className='flex items-center justify-between px-[20px] py-[16px]'
                  onClick={handleClearChat}
                >
                  <View className='flex items-center gap-[14px]'>
                    <View className='flex h-[40px] w-[40px] items-center justify-center rounded-[12px] bg-gradient-to-br from-[#f3e8ff] to-[#fce7f3] text-[18px]'>
                      <Text className='leading-none'>🗑️</Text>
                    </View>
                    <Text className='text-[16px] font-medium leading-[1.4] text-[var(--lb-text-primary)]'>
                      清除聊天记录
                    </Text>
                  </View>
                  <Text className='at-icon at-icon-chevron-right text-[16px] leading-none text-[var(--lb-text-muted)] [&::before]:block' />
                </View>
                <View className='app-hairline mx-[20px]' />
              </>
            )}

            <View
              className='flex items-center justify-between px-[20px] py-[16px]'
              onClick={handleLoginOrLogout}
            >
              <View className='flex items-center gap-[14px]'>
                <View className={`flex h-[40px] w-[40px] items-center justify-center rounded-[12px] text-[18px] ${isLoggedIn ? "bg-gradient-to-br from-[#fee2e2] to-[#ffe4e6]" : "app-gradient-surface shadow-[0_12px_24px_rgba(124,58,237,0.24)]"}`}>
                  <Text className='leading-none'>{isLoggedIn ? "↗" : "⇢"}</Text>
                </View>
                <Text className={`text-[16px] font-medium leading-[1.4] ${isLoggedIn ? "text-[#dc2626]" : "text-[var(--lb-grad-a)]"}`}>
                  {isLoggedIn ? "退出登录" : "立即登录"}
                </Text>
              </View>
              <Text className='at-icon at-icon-chevron-right text-[16px] leading-none text-[var(--lb-text-muted)] [&::before]:block' />
            </View>
          </View>
        </View>

        <View className='pt-[28px] text-center'>
          <Text className='block text-[13px] leading-[1.4] text-[var(--lb-text-muted)]'>Litter Bear v1.0.0</Text>
          <Text className='mt-[4px] block text-[12px] leading-[1.4] text-[rgba(156,163,175,0.78)]'>
            Powered by AI
          </Text>
        </View>
      </View>

      <TabBar current={2} />
    </View>
  );
}
