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
    <View className='app-page relative items-center justify-center overflow-hidden px-rpx-48'>
      <View className='pointer-events-none absolute -right-[120rpx] -top-[140rpx] h-[460rpx] w-[460rpx] rounded-td-pill-rpx bg-[#E2ECFF]' />
      <View className='pointer-events-none absolute -bottom-[220rpx] -left-[160rpx] h-[560rpx] w-[560rpx] rounded-td-pill-rpx bg-[#D8E6FF]' />

      <View className='app-surface app-animate-fade-in-up relative w-full max-w-[640rpx] rounded-td-xl-rpx px-rpx-64 py-rpx-72 box-border'>
        <Text className='mb-rpx-24 block text-center text-[120rpx] leading-none'>🐻</Text>
        <Text className='mb-rpx-16 block text-center text-rpx-48 font-bold leading-[1.2] text-td-text-primary'>
          Litter Bear
        </Text>
        <Text className='mb-rpx-96 block text-center text-rpx-28 leading-[1.5] text-td-text-secondary'>
          AI 智能助手
        </Text>

        <View
          className='w-full rounded-td-rpx bg-gradient-to-b from-[#1A67FF] to-[#0052D9] px-rpx-32 py-rpx-24 text-center shadow-[0_10rpx_24rpx_rgba(0,82,217,0.2)] box-border'
          onClick={handleLogin}
        >
          <Text className='text-rpx-32 font-semibold leading-[1.2] text-white'>微信登录</Text>
        </View>
      </View>
    </View>
  );
}
