import { View, Text, Image } from "@tarojs/components";
import Taro from "@tarojs/taro";
import TabBar from "../../components/TabBar";
import TabPageTopInset from "../../components/TabPageTopInset";
import { useUserStore } from "../../store/userStore";
import { useChatStore } from "../../store/chatStore";
import { STORAGE_KEYS } from "../../utils/constants";
import * as storage from "../../utils/storage";
import {
  appGlassCardClass,
  appGlassCardStrongClass,
  appGradientSurfaceClass,
  appGradientSurfaceWarmClass,
  appHairlineClass,
  appIconTileClass,
  appPageClass,
  appScreenClass,
} from "../../utils/style";

const accountCards = [
  { label: "会话记录", value: "本机保存", icon: "◷" },
  { label: "生成偏好", value: "默认模式", icon: "✦" },
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
    <View className={appPageClass}>
      <TabPageTopInset />
      <View className={appScreenClass}>
        <View className='px-[1rem] pb-[0.5rem] pt-[0.875rem]'>
          <View className={`${appGlassCardStrongClass} relative overflow-hidden`}>
            <View className='absolute inset-0 bg-gradient-to-br from-[rgba(124,58,237,0.1)] via-[rgba(236,72,153,0.1)] to-[rgba(79,70,229,0.1)]' />

            <View className='relative flex items-center px-[1.5rem] py-[1.75rem]'>
              <View className='relative'>
                {userInfo?.avatarUrl ? (
                  <Image
                    className='h-[5rem] w-[5rem] rounded-[1.5rem] border-2 border-white box-border shadow-[0_1.25rem_2.5rem_rgba(124,58,237,0.18)]'
                    src={userInfo.avatarUrl}
                    mode='aspectFill'
                  />
                ) : (
                  <View className={`${appIconTileClass} h-[4rem] w-[4rem] rounded-[1.125rem] text-[1.75rem] shadow-[0_0.875rem_1.75rem_rgba(236,72,153,0.24)]`}>
                    <Text className='leading-none'>🐻</Text>
                  </View>
                )}

                {isLoggedIn && (
                  <View className={`${appGradientSurfaceWarmClass} absolute -bottom-[0.25rem] -right-[0.25rem] flex h-[1.5rem] w-[1.5rem] items-center justify-center rounded-full border-2 border-white text-[0.75rem] shadow-[0_0.5rem_1.25rem_rgba(251,146,60,0.24)]`}>
                    <Text className='leading-none'>◔</Text>
                  </View>
                )}
              </View>

              <View className='ml-[1.125rem] min-w-0 flex-1'>
                <Text className='block text-[1.375rem] font-bold leading-[1.2] text-[var(--lb-text-primary)]'>
                  {isLoggedIn ? userInfo?.nickname || "小熊用户" : "未登录"}
                </Text>
                {isLoggedIn && (
                  <View className={`${appGradientSurfaceClass} mt-[0.625rem] inline-flex rounded-full px-[0.75rem] py-[0.375rem] shadow-[0_0.5rem_1.125rem_rgba(124,58,237,0.18)]`}>
                    <Text className='text-[0.75rem] font-semibold leading-none text-white'>Pro 会员</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </View>

        {isLoggedIn && (
          <View className='px-[1rem] pb-[0.5rem] pt-[0.625rem]'>
            <Text className='mb-[0.875rem] block px-[0.5rem] text-[1rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]'>
              使用概览
            </Text>
            <View className='grid grid-cols-2 gap-[0.75rem]'>
              {accountCards.map((item) => (
                <View key={item.label} className={`${appGlassCardClass} px-[1rem] py-[1rem]`}>
                  <View className='mb-[0.75rem] flex h-[2.5rem] w-[2.5rem] items-center justify-center rounded-[0.875rem] bg-[rgba(124,58,237,0.1)] text-[1.125rem] text-[var(--lb-grad-a)]'>
                    <Text className='leading-none'>{item.icon}</Text>
                  </View>
                  <Text className='block text-[0.875rem] font-medium leading-[1.4] text-[var(--lb-text-primary)]'>
                    {item.label}
                  </Text>
                  <Text className='mt-[0.25rem] block text-[0.75rem] leading-[1.4] text-[var(--lb-text-muted)]'>
                    {item.value}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View className='px-[1rem] pt-[0.875rem]'>
          <View className={`${appGlassCardClass} overflow-hidden`}>
            {isLoggedIn && (
              <>
                <View
                  className='flex items-center justify-between px-[1.25rem] py-[1rem]'
                  onClick={handleClearChat}
                >
                  <View className='flex items-center gap-[0.875rem]'>
                    <View className='flex h-[2.5rem] w-[2.5rem] items-center justify-center rounded-[0.75rem] bg-gradient-to-br from-[#f3e8ff] to-[#fce7f3] text-[1.125rem]'>
                      <Text className='leading-none'>🗑️</Text>
                    </View>
                    <Text className='text-[1rem] font-medium leading-[1.4] text-[var(--lb-text-primary)]'>
                      清除聊天记录
                    </Text>
                  </View>
                  <Text className='at-icon at-icon-chevron-right text-[1rem] leading-none text-[var(--lb-text-muted)] [&::before]:block' />
                </View>
                <View className={`${appHairlineClass} mx-[1.25rem]`} />
                <View className='flex items-center justify-between px-[1.25rem] py-[1rem]'>
                  <View className='flex items-center gap-[0.875rem]'>
                    <View className='flex h-[2.5rem] w-[2.5rem] items-center justify-center rounded-[0.75rem] bg-gradient-to-br from-[#eef2ff] to-[#f5ecff] text-[1.125rem]'>
                      <Text className='leading-none'>◌</Text>
                    </View>
                    <View>
                      <Text className='block text-[1rem] font-medium leading-[1.4] text-[var(--lb-text-primary)]'>
                        隐私与数据
                      </Text>
                      <Text className='mt-[0.125rem] block text-[0.75rem] leading-[1.4] text-[var(--lb-text-muted)]'>
                        Token 与会话仅保存在本机
                      </Text>
                    </View>
                  </View>
                </View>
                <View className={`${appHairlineClass} mx-[1.25rem]`} />
              </>
            )}

            <View
              className='flex items-center justify-between px-[1.25rem] py-[1rem]'
              onClick={handleLoginOrLogout}
            >
              <View className='flex items-center gap-[0.875rem]'>
                <View className={`flex h-[2.5rem] w-[2.5rem] items-center justify-center rounded-[0.75rem] text-[1.125rem] ${isLoggedIn ? "bg-gradient-to-br from-[#fee2e2] to-[#ffe4e6]" : `${appGradientSurfaceClass} shadow-[0_0.75rem_1.5rem_rgba(124,58,237,0.24)]`}`}>
                  <Text className='leading-none'>{isLoggedIn ? "↗" : "⇢"}</Text>
                </View>
                <Text className={`text-[1rem] font-medium leading-[1.4] ${isLoggedIn ? "text-[#dc2626]" : "text-[var(--lb-grad-a)]"}`}>
                  {isLoggedIn ? "退出登录" : "立即登录"}
                </Text>
              </View>
              <Text className='at-icon at-icon-chevron-right text-[1rem] leading-none text-[var(--lb-text-muted)] [&::before]:block' />
            </View>
          </View>
        </View>

        <View className='pt-[1.75rem] text-center'>
          <Text className='block text-[0.8125rem] leading-[1.4] text-[var(--lb-text-muted)]'>Litter Bear v1.0.0</Text>
          <Text className='mt-[0.25rem] block text-[0.75rem] leading-[1.4] text-[rgba(156,163,175,0.78)]'>
            Powered by AI
          </Text>
        </View>
      </View>

      <TabBar current={2} />
    </View>
  );
}
