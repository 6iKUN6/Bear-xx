import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useAgentStore } from "@/stores/agent-store";
import { useChatStore } from "@/stores/chat-store";
import { useModelStore } from "@/stores/model-store";
import { AgentMenu } from "@/components/AgentMenu";
import { AssistantMessage } from "@/components/AssistantMessage";
import { BrandTile } from "@/components/BrandTile";
import { ModelMenu } from "@/components/ModelMenu";
import { ThinkingMenu } from "@/components/ThinkingMenu";

const PROMPT_CHIPS = ["帮我写一份周报大纲", "解释一个技术概念", "规划一次周末出行"];

/**
 * 对话主区（Codex 风格）：助手消息无气泡卡片、正文直排；用户消息中性灰底小气泡。
 * 数据：GET /conversations + POST /chat/message（SSE 流式）。
 * 助手消息（markdown / trace / HITL 卡）由 AssistantMessage 组装。
 */
export function ChatView() {
  const user = useAppStore((s) => s.user);
  const setPage = useAppStore((s) => s.setPage);
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const sending = useChatStore((s) => s.sending);
  const send = useChatStore((s) => s.send);
  const loadConversations = useChatStore((s) => s.loadConversations);
  const agents = useAgentStore((s) => s.agents);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const loadAgents = useAgentStore((s) => s.loadAgents);

  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const conv = conversations.find((c) => c.id === activeId) ?? null;
  const messages = conv?.messages ?? [];

  // 生效智能体：选中的，否则落到默认智能体（用于拉模型选项；发送时仍按需带 agentId）
  const effectiveAgentId =
    selectedAgentId ?? agents.find((a) => a.isDefault && a.canUse)?.id ?? null;
  const modelSelection = useModelStore((s) =>
    effectiveAgentId ? s.selectionByAgent[effectiveAgentId] : undefined,
  );

  // 登录后拉取会话列表与智能体列表（退出登录时 app-store 已 reset）
  useEffect(() => {
    if (user) {
      void loadConversations();
      void loadAgents();
    }
  }, [user, loadConversations, loadAgents]);

  // 新内容贴底（简化版：不做「用户上滑后停止跟随」）
  const lastMessage = messages[messages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [activeId, messages.length, lastMessage?.content, lastMessage?.status]);

  const canSend = Boolean(user) && draft.trim().length > 0 && !sending;

  const handleSend = () => {
    if (!canSend) {
      return;
    }
    // 模型/思考选择只在该智能体确有可选项时携带（自定义 Flow Agent 无模型，传了也会被拒）
    send(draft, {
      agentId: selectedAgentId,
      selectedModelPresetId: modelSelection?.modelPresetId,
      reasoning: modelSelection?.reasoning,
    });
    setDraft("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[var(--lb-page-background)]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pb-6 pt-10">
        {messages.length === 0 ? (
          <div className="mx-auto mt-[16vh] max-w-[420px] text-center">
            <BrandTile size={56} />
            <h2 className="mt-4 text-xl font-bold">今天想做什么？</h2>
            <p className="mt-2 text-[var(--lb-text-secondary)]">
              直接输入你的问题或想法，开始这段对话。
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {PROMPT_CHIPS.map((text) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => {
                    setDraft(text);
                    inputRef.current?.focus();
                  }}
                  className="rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-3.5 py-2 text-[13px] text-[var(--lb-text-secondary)] transition-colors hover:bg-[var(--lb-surface-hover)] hover:text-[var(--lb-text-primary)]"
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[720px] flex-col gap-6">
            {messages.map((msg) =>
              msg.role === "user" ? (
                <div key={msg.id} className="max-w-[75%] self-end">
                  <div className="rounded-[var(--lb-radius-md)] bg-[var(--lb-surface-hover)] px-3.5 py-2.5 text-sm leading-relaxed">
                    {msg.content}
                  </div>
                </div>
              ) : (
                <AssistantMessage key={msg.id} message={msg} />
              ),
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 px-6 pb-5 pt-3">
        {!user && (
          <div className="mx-auto mb-2 flex max-w-[720px] items-center justify-between rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-3.5 py-2">
            <span className="text-[13px] text-[var(--lb-text-secondary)]">
              登录后开始对话
            </span>
            <button
              type="button"
              onClick={() => setPage("login")}
              className="lb-accent-surface inline-flex h-7 items-center rounded-[var(--lb-radius-sm)] px-3 text-[12px] font-semibold text-[var(--lb-on-accent)] transition-opacity hover:opacity-90"
            >
              去登录
            </button>
          </div>
        )}
        {user && (
          <div className="mx-auto mb-1.5 flex max-w-[720px] items-center gap-2">
            <AgentMenu />
            <ModelMenu agentId={effectiveAgentId} />
            <ThinkingMenu agentId={effectiveAgentId} />
          </div>
        )}
        <div className="mx-auto flex max-w-[720px] items-end gap-2.5 rounded-[var(--lb-radius-md)] border border-[var(--lb-line-strong)] bg-[var(--lb-surface)] py-2.5 pl-4 pr-2.5 shadow-[var(--lb-shadow-card)] focus-within:border-[var(--lb-accent)]">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            disabled={!user}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              user
                ? "今天想做什么？（Enter 发送，Shift+Enter 换行）"
                : "登录后开始对话"
            }
            aria-label="输入消息"
            className="max-h-[140px] flex-1 resize-none bg-transparent py-1.5 text-sm leading-6 outline-none placeholder:text-[var(--lb-text-muted)] disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="发送"
            className="lb-accent-surface flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--lb-on-accent)] transition-opacity hover:opacity-90 disabled:bg-[var(--lb-surface-hover)] disabled:text-[var(--lb-text-muted)]"
          >
            <ArrowUp size={16} />
          </button>
        </div>
        <div className="mx-auto mt-1.5 max-w-[720px] text-center text-[11px] text-[var(--lb-text-muted)]">
          Sola 桌面端 · 由 Sola Runtime 驱动
        </div>
      </div>
    </main>
  );
}
