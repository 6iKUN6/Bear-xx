import { useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import AppIcon from "../../components/AppIcon";
import ChatWorkspace from "../../components/ChatWorkspace";
import HistoryDrawer from "../../components/HistoryDrawer";
import NewChatPanel from "../../components/NewChatPanel";
import { useChatStore } from "../../store/chatStore";
import { appNavIconButtonClass } from "../../utils/style";

/**
 * 首页 = 对话工作台
 * @description 无当前会话时显示新对话页（可先选智能体再开聊）；左上角按钮打开
 * 历史抽屉（今天/昨天/七天内/30天内分组），点击条目原地切换会话。
 *
 * 这里刻意不做「自动落到最近一次会话」：那个 effect 会在 currentConversation
 * 被置空的瞬间把最近会话选回来，导致「发起新对话」永远生效不了。
 */
export default function IndexPage() {
  const {
    conversations,
    currentConversation,
    loadConversations,
    setCurrentConversation,
    clearCurrentConversation,
    deleteConversation,
  } = useChatStore();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useDidShow(() => {
    void loadConversations();
  });

  const historyButton = (
    <View
      className={appNavIconButtonClass}
      onClick={() => setDrawerOpen(true)}
    >
      <AppIcon name="list" className="h-[1.125rem] w-[1.125rem]" />
    </View>
  );

  return (
    <>
      <ChatWorkspace
        navLeft={historyButton}
        renderEmpty={({ setDraft }) => (
          <NewChatPanel onPickPrompt={setDraft} />
        )}
      />

      <HistoryDrawer
        open={drawerOpen}
        conversations={conversations}
        currentId={currentConversation?.id ?? null}
        onSelect={setCurrentConversation}
        onCreate={clearCurrentConversation}
        onOpenAgents={() => {
          void Taro.navigateTo({ url: "/pages/agents/index" });
        }}
        onOpenSettings={() => {
          void Taro.navigateTo({ url: "/pages/profile/index" });
        }}
        onDelete={(id) => {
          void deleteConversation(id);
        }}
        onClose={() => setDrawerOpen(false)}
      />
    </>
  );
}
