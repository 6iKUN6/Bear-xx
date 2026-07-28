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
    // 恢复选中的智能体
    useAgentStore.getState().hydrate();
  });

  return children;
}

export default App;
