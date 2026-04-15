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
    <View className='app-page items-center justify-center px-[24px]'>
      <View className='app-blur-orb app-float left-[16%] top-[96px] h-[180px] w-[180px] bg-[rgba(196,181,253,0.5)]' />
      <View className='app-blur-orb app-float-delayed bottom-[120px] right-[10%] h-[220px] w-[220px] bg-[rgba(165,180,252,0.42)]' />

      <View className='app-glass-card-strong relative z-[10] w-full max-w-[340px] px-[32px] py-[40px]'>
        <View className='mb-[32px] flex justify-center'>
          <View className='relative'>
            <View className='app-icon-tile h-[96px] w-[96px] rounded-[28px] text-[52px] shadow-[0_18px_42px_rgba(124,58,237,0.28)]'>
              <Text className='leading-none'>🐻</Text>
            </View>
            <View className='app-gradient-surface-warm app-twinkle absolute -right-[4px] -top-[4px] flex h-[32px] w-[32px] items-center justify-center rounded-full text-[14px] shadow-[0_10px_22px_rgba(251,146,60,0.28)]'>
              <Text className='leading-none'>✦</Text>
            </View>
          </View>
        </View>

        <Text className='app-gradient-text mb-[10px] block text-center text-[32px] font-bold leading-[1.2]'>
          Litter Bear
        </Text>
        <Text className='mb-[40px] block text-center text-[16px] leading-[1.5] text-[var(--lb-text-secondary)]'>
          你的 AI 智能助手
        </Text>

        <View
          className='app-gradient-surface flex h-[56px] w-full items-center justify-center gap-[10px] rounded-[18px] shadow-[0_18px_34px_rgba(124,58,237,0.28)]'
          onClick={handleLogin}
        >
          <Text className='text-[22px] leading-none text-white'>◉</Text>
          <Text className='text-[17px] font-semibold leading-none text-white'>微信一键登录</Text>
        </View>

        <Text className='mt-[24px] block text-center text-[12px] leading-[1.4] text-[var(--lb-text-muted)]'>
          安全 · 快速 · 智能
        </Text>
      </View>
    </View>
  );
}
