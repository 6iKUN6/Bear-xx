import { PropsWithChildren } from "react";
import Taro, { useLaunch } from "@tarojs/taro";
import { useUserStore } from "./store/userStore";
import { useChatStore } from "./store/chatStore";
import { useThemeStore } from "./store/themeStore";
import { useAgentStore } from "./store/agentStore";

import "./app.scss";
import "./app.css";

// type LegacySystemInfoOptions = {
//   success?: (res: Record<string, any>) => void;
//   fail?: (err: unknown) => void;
//   complete?: (res: Record<string, any> | unknown) => void;
// };

/**
 * 确保系统信息兼容
 * @returns
 */
function ensureSystemInfoCompat() {
  const info =
    Taro.getEnv() === Taro.ENV_TYPE.WEAPP
      ? {
          windowInfo: Taro.getWindowInfo(),
          deviceInfo: Taro.getDeviceInfo(),
          appBaseInfo: Taro.getAppBaseInfo(),
          systemSetting: Taro.getSystemSetting(),
        }
      : Taro.getSystemInfoSync();

  console.log(
    "%c System Info %c",
    "color: #0ea5e9; font-weight: bold; padding: 2px 8px; border-radius: 4px; background: #e0f2fe;",
    "",
    info,
  );

  return info;
}

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    ensureSystemInfoCompat();

    // 恢复登录态
    useUserStore.getState().hydrate();
    // 恢复会话数据
    useChatStore.getState().hydrateConversations();
    // 恢复界面主题
    useThemeStore.getState().hydrate();
    // 恢复选中的智能体与智能体列表缓存
    useAgentStore
      .getState()
      .hydrate(useUserStore.getState().userInfo?.id ?? null);
    // 智能体列表是头像与 @ 候选的唯一来源，且非会话页也可能首屏直达群聊，
    // 故启动即拉一次（失败不影响主流程，各页面挂载时还会 ensure 重试）。
    if (useUserStore.getState().isLoggedIn) {
      void useAgentStore.getState().loadAgents();
    }
  });

  return children;
}

export default App;
