import { View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { loginByWechat } from "../../api/user";
import { useUserStore } from "../../store/userStore";
import "./index.scss";

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
    <View className='app-page login-page'>
      <View className='login-page__orb login-page__orb--top' />
      <View className='login-page__orb login-page__orb--bottom' />

      <View className='app-surface login-page__card app-animate-fade-in-up'>
        <Text className='login-page__logo'>🐻</Text>
        <Text className='login-page__title'>
          Litter Bear
        </Text>
        <Text className='login-page__subtitle'>
          AI 智能助手
        </Text>

        <View
          className='login-page__button'
          onClick={handleLogin}
        >
          <Text className='login-page__button-text'>微信登录</Text>
        </View>
      </View>
    </View>
  );
}
