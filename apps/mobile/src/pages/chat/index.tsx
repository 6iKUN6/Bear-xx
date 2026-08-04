import { useRouter } from "@tarojs/taro";
import ChatWorkspace from "../../components/ChatWorkspace";

/**
 * 独立聊天页（深链/外部跳转入口）
 * @description 首页已直显最近对话，本页保留给带 conversationId 的显式导航场景；
 * 全部交互由共享的 ChatWorkspace 承载。
 */
export default function ChatPage() {
  const router = useRouter();
  const conversationId = router.params.conversationId || "";

  return <ChatWorkspace conversationId={conversationId} showBack />;
}
