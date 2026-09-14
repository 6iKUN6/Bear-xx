import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";

/** 工作台页：左侧栏 + 对话主区（标题栏用系统原生的，渲染层不画） */
export function WorkbenchPage() {
  return (
    <div className="flex h-full">
      <Sidebar />
      <ChatView />
    </div>
  );
}
