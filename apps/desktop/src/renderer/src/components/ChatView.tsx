import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  BookOpen,
  MessageSquare,
  Plus,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useAgentStore } from "@/stores/agent-store";
import { useChatStore } from "@/stores/chat-store";
import { modelSelectionKey, useModelStore } from "@/stores/model-store";
import { AssistantMessage } from "./AssistantMessage";
import { Composer } from "./Composer";
import { ModelControls } from "./ModelControls";
import { Button, IconButton } from "./ui";

export function ChatView() {
  const user = useAppStore((s) => s.user);
  const { conversations, activeId, sending, send, drafts, setDraft } =
    useChatStore();
  const { agents, selectedAgentId } = useAgentStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const conv = conversations.find((c) => c.id === activeId);
  const messages = conv?.messages ?? [];
  const draftKey = activeId ?? "new";
  const draft = drafts[draftKey] ?? "";
  const effectiveAgentId =
    selectedAgentId ??
    conv?.defaultAgentId ??
    agents.find((agent) => agent.isDefault && agent.canUse)?.id ??
    null;
  const modelSelection = useModelStore((s) =>
    effectiveAgentId
      ? s.selectionByScope[modelSelectionKey(effectiveAgentId)]
      : undefined,
  );
  const last = messages[messages.length - 1];
  useEffect(() => {
    follows.current = true;
    setShowLatest(false);
  }, [activeId]);
  useEffect(() => {
    if (follows.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [
    activeId,
    messages.length,
    last?.content,
    last?.status,
    last?.streamFeedback,
  ]);
  function handleSend() {
    if (!user || sending || !draft.trim()) return;
    const id = send(draft, {
      agentId: effectiveAgentId,
      selectedModelPresetId: modelSelection?.modelPresetId,
      reasoning: modelSelection?.reasoning,
    });
    if (id) {
      setDraft(draftKey, "");
      follows.current = true;
    }
  }
  return (
    <main className={`chat-page ${messages.length === 0 ? "empty" : ""}`}>
      <header className="workspace-heading">
        <div className="breadcrumb">
          <MessageSquare size={15} />
          <span>{conv?.title || "新对话"}</span>
        </div>
        <IconButton
          label="开始新对话"
          onClick={() => useChatStore.getState().setActive(null)}
        >
          <Plus size={17} />
        </IconButton>
      </header>
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          follows.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          setShowLatest(!follows.current);
        }}
      >
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <p className="eyebrow">A LITTLE SPARK, A NEW BEGINNING</p>
            <h1>今天，从哪个想法开始？</h1>
            <p>问一个问题，聊一个灵感，或一起打磨你的下一个故事。</p>
            <div className="welcome-actions">
              <Button
                onClick={() =>
                  setDraft(
                    draftKey,
                    "帮我一起构思一个故事。我会先说说我的灵感。",
                  )
                }
              >
                一起构思故事
                <ArrowUpRight size={13} />
              </Button>
              <Button
                onClick={() =>
                  setDraft(
                    draftKey,
                    "帮我梳理以下想法，找出值得进一步探索的方向：",
                  )
                }
              >
                整理我的想法
                <ArrowUpRight size={13} />
              </Button>
            </div>
          </div>
        ) : (
          <div className="message-list">
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="user-message">
                  {message.content}
                </div>
              ) : (
                <AssistantMessage key={message.id} message={message} />
              ),
            )}
          </div>
        )}
      </div>
      <div className="chat-composer-wrap">
        {showLatest && (
          <Button
            className="latest-button"
            onClick={() => {
              follows.current = true;
              scrollRef.current?.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: "smooth",
              });
            }}
          >
            <ArrowDown size={14} />
            回到最新
          </Button>
        )}
        <Composer
          value={draft}
          onChange={(value) => setDraft(draftKey, value)}
          onSend={handleSend}
          controls={<ModelControls agentId={effectiveAgentId} />}
          placeholder="输入问题，或者从一个还不完整的想法开始…"
        />
        {messages.length === 0 && (
          <button
            type="button"
            className="chat-creation-link"
            onClick={() => useAppStore.getState().setPage("projects")}
          >
            <BookOpen size={15} />
            想持续完成一部作品？前往创作空间
            <ArrowUpRight size={13} />
          </button>
        )}
      </div>
    </main>
  );
}
