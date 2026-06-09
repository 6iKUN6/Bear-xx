import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { loginByWechat } from "../../api/user";
import { useUserStore } from "../../store/userStore";
import {
  appBlurOrbClass,
  appGlassCardStrongClass,
  appGradientSurfaceClass,
  appGradientSurfaceWarmClass,
  appGradientTextClass,
  appIconTileClass,
  appPageClass,
} from "../../utils/style";

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
    <View className={`${appPageClass} items-center justify-center px-[1.5rem]`}>
      <View className={`${appBlurOrbClass} left-[16%] top-[6rem] h-[11.25rem] w-[11.25rem] animate-app-float bg-[rgba(196,181,253,0.5)]`} />
      <View className={`${appBlurOrbClass} bottom-[7.5rem] right-[10%] h-[13.75rem] w-[13.75rem] animate-app-float-delayed bg-[rgba(165,180,252,0.42)]`} />

      <View className={`${appGlassCardStrongClass} relative z-[10] w-full max-w-[21.25rem] px-[2rem] py-[2.5rem]`}>
        <View className='mb-[2rem] flex justify-center'>
          <View className='relative'>
            <View className={`${appIconTileClass} h-[6rem] w-[6rem] rounded-[1.75rem] text-[3.25rem] shadow-[0_1.125rem_2.625rem_rgba(124,58,237,0.28)]`}>
              <Text className='leading-none'>🐻</Text>
            </View>
            <View className={`${appGradientSurfaceWarmClass} absolute -right-[0.25rem] -top-[0.25rem] flex h-[2rem] w-[2rem] animate-app-twinkle items-center justify-center rounded-full text-[0.875rem] shadow-[0_0.625rem_1.375rem_rgba(251,146,60,0.28)]`}>
              <Text className='leading-none'>✦</Text>
            </View>
          </View>
        </View>

        <Text className={`${appGradientTextClass} mb-[0.625rem] block text-center text-[2rem] font-bold leading-[1.2]`}>
          Litter Bear
        </Text>
        <Text className='mb-[2.5rem] block text-center text-[1rem] leading-[1.5] text-[var(--lb-text-secondary)]'>
          你的 AI 智能助手
        </Text>

        <View
          className={`${appGradientSurfaceClass} flex h-[3.5rem] w-full items-center justify-center gap-[0.625rem] rounded-[1.125rem] shadow-[0_1.125rem_2.125rem_rgba(124,58,237,0.28)]`}
          onClick={handleLogin}
        >
          <Text className='text-[1.375rem] leading-none text-white'>◉</Text>
          <Text className='text-[1.0625rem] font-semibold leading-none text-white'>微信一键登录</Text>
        </View>

        <Text className='mt-[1.5rem] block text-center text-[0.75rem] leading-[1.4] text-[var(--lb-text-muted)]'>
          安全 · 快速 · 智能
        </Text>
      </View>
    </View>
  );
}
