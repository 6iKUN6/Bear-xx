import { PropsWithChildren } from "react";
import { useLaunch } from "@tarojs/taro";
import { useUserStore } from "./store/userStore";
import { useChatStore } from "./store/chatStore";

import "./app.scss";

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    // 恢复登录态
    useUserStore.getState().hydrate();
    // 恢复会话数据
    useChatStore.getState().hydrateConversations();
  });

  return children;
}

export default App;
