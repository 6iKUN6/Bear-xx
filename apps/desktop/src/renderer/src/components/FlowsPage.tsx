import { ArrowRight, Bot, GitBranch, Lock } from "lucide-react";
import { useAgentStore } from "@/stores/agent-store";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { useCreationStore } from "@/stores/creation-store";
import type { CreationProject } from "@/lib/creation";
import { Button, Notice } from "./ui";

export function FlowsPage({ project }: { project?: CreationProject }) {
  const { agents, loaded, loadError, loadAgents } = useAgentStore();
  const user = useAppStore((s) => s.user);
  return (
    <section className={`flows-page ${project ? "" : "page-scroll"}`}>
      <p className="eyebrow">CREATIVE WORKFLOWS</p>
      <h1>{project ? "这个项目如何生成" : "选择适合你的创作流程"}</h1>
      <p className="muted flow-intro">
        {project
          ? "为项目选择一个助手。模型与工具按该助手的配置执行，每次生成的结果由你决定是否采用。"
          : "使用账号中已有的助手与流程开始创作。桌面端的流程编排编辑尚未开放。"}
      </p>
      {project && (
        <div className="writing-steps">
          {["项目设定", "章节大纲", "正文生成", "预览与采用"].map(
            (label, index) => (
              <div key={label}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{label}</strong>
                {index < 3 && <ArrowRight size={14} />}
              </div>
            ),
          )}
        </div>
      )}
      {!user ? (
        <div className="flow-empty">
          <GitBranch size={30} />
          <h2>登录后查看可用流程</h2>
          <p className="muted">项目编辑不受影响，连接账号后即可使用 AI。</p>
          <Button onClick={() => useAppStore.getState().setPage("login")}>
            登录账号
          </Button>
        </div>
      ) : loadError ? (
        <Notice
          action={<Button onClick={() => void loadAgents()}>重试</Button>}
        >
          {loadError}
        </Notice>
      ) : !loaded ? (
        <p className="muted">正在读取可用流程…</p>
      ) : agents.length === 0 ? (
        <div className="flow-empty">
          <Bot size={30} />
          <h2>当前账号还没有可用助手</h2>
          <p className="muted">请先在管理端配置并开放助手。</p>
          <Button onClick={() => void loadAgents()}>刷新</Button>
        </div>
      ) : (
        <div className="flow-list">
          {project && (
            <button
              type="button"
              className={`flow-option ${project.agentId === null ? "selected" : ""}`}
              onClick={() =>
                useCreationStore
                  .getState()
                  .update(project.id, { agentId: null })
              }
            >
              <Bot size={20} />
              <span>
                <strong>默认助手</strong>
                <small>使用账号默认配置</small>
              </span>
              <span className="pill">
                {project.agentId === null ? "当前使用" : "选择"}
              </span>
            </button>
          )}
          {agents.map((agent) => (
            <button
              type="button"
              className={`flow-option ${project?.agentId === agent.id ? "selected" : ""}`}
              key={agent.id}
              disabled={!agent.canUse}
              onClick={() => {
                if (project) {
                  useCreationStore
                    .getState()
                    .update(project.id, { agentId: agent.id });
                  return;
                }
                useAgentStore.getState().selectAgent(agent.id);
                useChatStore.getState().setActive(null);
                useAppStore.getState().setPage("workbench");
              }}
            >
              {agent.defaultFlowVersionId ? (
                <GitBranch size={20} />
              ) : (
                <Bot size={20} />
              )}
              <span>
                <strong>{agent.name}</strong>
                <small>
                  {agent.description ||
                    (agent.defaultFlowVersionId
                      ? "运行已绑定的完整流程"
                      : "直接对话，支持按可用配置调整模型")}
                </small>
              </span>
              <span className="pill">
                {!agent.canUse ? (
                  <>
                    <Lock size={11} />
                    不可用
                  </>
                ) : project?.agentId === agent.id ? (
                  "当前使用"
                ) : agent.defaultFlowVersionId ? (
                  "自定义流程"
                ) : (
                  "直接对话"
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
