import { useEffect, useRef, useState } from "react";
import { FileText, Sparkles, X, Check, Undo2 } from "lucide-react";
import {
  buildCreationPrompt,
  type Chapter,
  type CreationProject,
  type EditTarget,
} from "@/lib/creation";
import { useAppStore } from "@/stores/app-store";
import { useCreationStore } from "@/stores/creation-store";
import { useChatStore } from "@/stores/chat-store";
import { useAgentStore } from "@/stores/agent-store";
import { modelSelectionKey, useModelStore } from "@/stores/model-store";
import { AssistantMessage } from "./AssistantMessage";
import { ModelControls } from "./ModelControls";
import { Composer } from "./Composer";
import { Button, CopyButton, IconButton, Notice } from "./ui";

export function CreationAssistant({
  project,
  chapter,
  selection,
}: {
  project: CreationProject;
  chapter?: Chapter;
  selection: EditTarget | null;
}) {
  const user = useAppStore((s) => s.user);
  const scopeId = `project:${project.id}:${user?.id ?? "guest"}`;
  const draft = useCreationStore((s) => s.drafts[scopeId] ?? "");
  const proposal = useCreationStore((s) => s.proposals[scopeId]);
  const stage = useCreationStore((s) => s.stage);
  const { conversations, sending, loading, loadError } = useChatStore();
  const agents = useAgentStore((s) => s.agents);
  const conversationId = user ? project.conversations[user.id] : undefined;
  const conversation = conversations.find((item) => item.id === conversationId);
  const conversationMissing = Boolean(user && conversationId && !conversation);
  const agentId =
    project.agentId ??
    agents.find((agent) => agent.isDefault && agent.canUse)?.id ??
    null;
  const selectedAgent = agents.find((agent) => agent.id === agentId);
  const model = useModelStore((s) =>
    agentId
      ? s.selectionByScope[modelSelectionKey(agentId, scopeId)]
      : undefined,
  );
  const [mode, setMode] = useState<"ask" | "write">("ask");
  const [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const messages = conversation?.messages ?? [];
  const last = messages[messages.length - 1];
  useEffect(() => {
    if (follows.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [last?.content, last?.status, messages.length, proposal]);
  const canWrite = stage === "writing" && Boolean(chapter);
  const activeSelection =
    selection &&
    chapter?.content === selection.before &&
    chapter.id === selection.chapterId
      ? selection
      : null;
  function send() {
    if (!user || sending || conversationMissing || !draft.trim()) return;
    setError("");
    if (project.agentId && (!selectedAgent || !selectedAgent.canUse)) {
      setError("项目配置的助手当前不可用，请在创作流程中重新选择。");
      return;
    }
    const target =
      mode === "write" && canWrite && chapter
        ? (activeSelection ?? {
            chapterId: chapter.id,
            before: chapter.content,
            start: 0,
            end: chapter.content.length,
          })
        : null;
    try {
      const content = buildCreationPrompt(project, chapter, draft, target);
      const messageId = useChatStore.getState().send(content, {
        conversationId: conversationId?.startsWith("local-")
          ? null
          : (conversationId ?? null),
        agentId,
        selectedModelPresetId: model?.modelPresetId,
        reasoning: model?.reasoning,
        onConversationId: (id) =>
          useCreationStore.getState().bindConversation(project.id, user.id, id),
        onComplete: (message) => {
          if (
            target &&
            message.status === "done" &&
            !message.canceled &&
            message.content.trim()
          ) {
            useCreationStore
              .getState()
              .setProposal(scopeId, { target, content: message.content });
          }
        },
      });
      if (messageId) {
        useCreationStore.getState().setDraft(scopeId, "");
        follows.current = true;
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "发送失败");
    }
  }
  return (
    <aside className="creation-assistant" aria-label="创作助手">
      <header className="assistant-heading">
        <Sparkles size={16} />
        <strong>创作助手</strong>
        <IconButton
          label="收起创作助手"
          onClick={() => useCreationStore.getState().toggleAssistant()}
        >
          <X size={16} />
        </IconButton>
      </header>
      <div className="context-summary">
        <FileText size={14} />
        <span>项目设定{chapter ? ` · ${chapter.title}` : ""}</span>
        <small>{activeSelection ? "含选中片段" : "含当前章节"}</small>
      </div>
      <div
        className="assistant-scroll"
        ref={scroll}
        onScroll={(event) => {
          const el = event.currentTarget;
          follows.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {conversationMissing &&
          (loading ? (
            <p className="muted text-xs">正在载入项目助手会话…</p>
          ) : (
            <Notice
              action={
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() =>
                      void useChatStore.getState().loadConversations()
                    }
                  >
                    重新加载
                  </Button>
                  <Button
                    disabled={sending}
                    onClick={() => {
                      if (user)
                        useCreationStore
                          .getState()
                          .bindConversation(project.id, user.id, null);
                    }}
                  >
                    开始新会话
                  </Button>
                </div>
              }
            >
              {loadError ||
                "未找到项目关联的助手会话，可以重新加载或开始新会话。"}
            </Notice>
          ))}
        {!messages.length && !conversationMissing && (
          <div className="assistant-intro">
            <div className="assistant-spark">
              <Sparkles size={21} />
            </div>
            <h3>一起，把故事写下去。</h3>
            <p>聊设定、推敲情节，或让助手为当前章节试写一段。</p>
            <p>
              发送时会附上项目设定和当前章节。生成结果需你确认后才写入正文。
            </p>
            <div className="assistant-prompts">
              <button
                type="button"
                onClick={() => {
                  setMode("ask");
                  useCreationStore
                    .getState()
                    .setDraft(
                      scopeId,
                      "根据当前设定，帮我梳理故事中最值得展开的冲突。",
                    );
                }}
              >
                梳理故事冲突
              </button>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => {
                    setMode("write");
                    useCreationStore
                      .getState()
                      .setDraft(
                        scopeId,
                        chapter?.content
                          ? "润色这段正文，保留情节与人物动机，让语言更自然。"
                          : "根据章节大纲写出这一章，注重人物行动与场景细节。",
                      );
                  }}
                >
                  {chapter?.content ? "润色当前章节" : "根据大纲试写"}
                </button>
              )}
            </div>
          </div>
        )}
        {messages.map((message) =>
          message.role === "assistant" ? (
            <AssistantMessage key={message.id} message={message} />
          ) : (
            <details className="context-message" key={message.id}>
              <summary>{message.content.split("用户要求：").pop()}</summary>
              <pre>{message.content}</pre>
            </details>
          ),
        )}
        {proposal && (
          <div className="proposal">
            <div className="proposal-heading">
              <Sparkles size={14} />
              <strong>
                {proposal.appliedContent === undefined
                  ? "正文建议 · 待采用"
                  : "已采用到正文"}
              </strong>
            </div>
            <p className="muted text-xs">
              对应：
              {project.chapters.find(
                (item) => item.id === proposal.target.chapterId,
              )?.title || "章节已删除"}{" "}
              ·{" "}
              {proposal.target.start === 0 &&
              proposal.target.end === proposal.target.before.length
                ? "替换整章"
                : "替换选中片段"}
            </p>
            <div className="proposal-content">{proposal.content}</div>
            <details>
              <summary>查看生成前的原文</summary>
              <div className="proposal-content">
                {proposal.target.before || "（原章节为空）"}
              </div>
            </details>
            <div className="proposal-actions">
              {proposal.appliedContent === undefined ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    try {
                      useCreationStore.getState().adopt(project.id, scopeId);
                      setError("");
                    } catch (error) {
                      setError(
                        error instanceof Error ? error.message : "采用失败",
                      );
                    }
                  }}
                >
                  <Check size={13} />
                  采用到正文
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    try {
                      useCreationStore.getState().undo(project.id, scopeId);
                      setError("");
                    } catch (error) {
                      setError(
                        error instanceof Error ? error.message : "撤销失败",
                      );
                    }
                  }}
                >
                  <Undo2 size={13} />
                  撤销采用
                </Button>
              )}
              <CopyButton content={proposal.content} />
            </div>
          </div>
        )}
      </div>
      <div className="assistant-compose-wrap">
        {error && <Notice>{error}</Notice>}
        {canWrite && (
          <div className="assistant-mode">
            <button
              type="button"
              aria-pressed={mode === "ask"}
              className={mode === "ask" ? "active" : ""}
              onClick={() => setMode("ask")}
            >
              讨论想法
            </button>
            <button
              type="button"
              aria-pressed={mode === "write"}
              className={mode === "write" ? "active" : ""}
              onClick={() => setMode("write")}
            >
              {activeSelection ? "改写选中片段" : "生成正文建议"}
            </button>
          </div>
        )}
        <Composer
          disabled={conversationMissing}
          value={draft}
          onChange={(value) =>
            useCreationStore.getState().setDraft(scopeId, value)
          }
          onSend={send}
          placeholder={
            canWrite && mode === "write"
              ? "希望怎样修改或撰写这一章？"
              : "聊聊情节、人物，或你的下一个想法…"
          }
          controls={
            <ModelControls
              agentId={agentId}
              selectedAgentId={project.agentId}
              scopeId={scopeId}
              onAgentChange={(id) =>
                useCreationStore.getState().update(project.id, { agentId: id })
              }
            />
          }
        />
      </div>
    </aside>
  );
}
