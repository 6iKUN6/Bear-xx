import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { loginByWechat } from "../../api/user";
import { useUserStore } from "../../store/userStore";

export default function LoginPage() {
  const login = useUserStore((s) => s.login);

  const handleLogin = async () => {
    try {
      Taro.showLoading({ title: "登录中..." });
      const { code } = await Taro.login();
      const result = await loginByWechat(code);
      login(result);
      Taro.hideLoading();
      Taro.redirectTo({ url: "/pages/index/index" });
    } catch (err) {
      Taro.hideLoading();
      Taro.showToast({ title: "登录失败，请重试", icon: "none" });
      console.error("Login failed:", err);
    }
  };

  return (
    <View className='relative flex flex-col items-center justify-center min-h-screen px-6 bg-td-bg-page overflow-hidden'>
      <View className='absolute right-[-120rpx] top-[-140rpx] w-[460rpx] h-[460rpx] rounded-full bg-[#E2ECFF]' />
      <View className='absolute left-[-160rpx] bottom-[-220rpx] w-[560rpx] h-[560rpx] rounded-full bg-[#D8E6FF]' />

      <View className='relative w-full max-w-[640rpx] bg-white rounded-td-xl shadow-td border border-td-border-base px-8 py-[72rpx] animate-fade-in-up'>
        <Text className='text-[120rpx] block text-center mb-3'>🐻</Text>
        <Text className='text-[52rpx] font-semibold text-td-text-primary block text-center mb-2'>
          Litter Bear
        </Text>
        <Text className='text-[28rpx] text-td-text-secondary block text-center mb-12'>
          AI 智能助手
        </Text>

        <View
          className='w-full py-[24rpx] bg-td-brand rounded-td text-center active:scale-95 transition-transform duration-150 shadow-td-sm'
          onClick={handleLogin}
        >
          <Text className='text-white text-[32rpx] font-medium'>微信登录</Text>
        </View>
      </View>
    </View>
  );
}
