import { PropsWithChildren } from "react";
import Taro, { useLaunch } from "@tarojs/taro";
import { useUserStore } from "./store/userStore";
import { useChatStore } from "./store/chatStore";

import "./app.css";
import "./app.scss";

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
  const info = Taro.getSystemInfoSync();

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
  });

  return children;
}

export default App;
