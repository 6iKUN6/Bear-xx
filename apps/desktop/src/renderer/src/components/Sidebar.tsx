import {
  BookOpen,
  FolderOpen,
  GitBranch,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { useCreationStore } from "@/stores/creation-store";
import { BrandTile } from "./BrandTile";
import { IconButton } from "./ui";

export function Sidebar() {
  const {
    page,
    setPage,
    user,
    sidebarCollapsed: collapsed,
    toggleSidebar,
  } = useAppStore();
  const {
    conversations,
    activeId,
    setActive,
    loading,
    loadError,
    loadConversations,
  } = useChatStore();
  const projects = useCreationStore((s) => s.projects);
  const activeProjectId = useCreationStore((s) => s.activeProjectId);
  const newChat = () => {
    setActive(null);
    setPage("workbench");
  };
  const projectConversations = new Set(
    projects.flatMap((project) =>
      user ? [project.conversations[user.id]] : [],
    ),
  );
  const history = conversations.filter(
    (conversation) => !projectConversations.has(conversation.id),
  );
  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="brand">
        <BrandTile />
        <strong>Sola</strong>
        <IconButton
          label={collapsed ? "展开侧栏" : "收起侧栏"}
          onClick={toggleSidebar}
        >
          {collapsed ? (
            <PanelLeftOpen size={16} />
          ) : (
            <PanelLeftClose size={16} />
          )}
        </IconButton>
      </div>
      <nav className="main-nav" aria-label="主导航">
        <button
          type="button"
          className={`nav-item ${page === "workbench" ? "active" : ""}`}
          title="对话"
          onClick={() => setPage("workbench")}
          aria-current={page === "workbench" ? "page" : undefined}
        >
          <MessageSquare size={18} />
          <span>对话</span>
        </button>
        <button
          type="button"
          className={`nav-item ${page === "projects" || page === "creation" ? "active" : ""}`}
          title="创作"
          onClick={() => setPage("projects")}
          aria-current={
            page === "projects" || page === "creation" ? "page" : undefined
          }
        >
          <FolderOpen size={18} />
          <span>创作</span>
          <small>{projects.length || ""}</small>
        </button>
        <button
          type="button"
          className={`nav-item ${page === "flows" ? "active" : ""}`}
          title="创作流程"
          onClick={() => setPage("flows")}
          aria-current={page === "flows" ? "page" : undefined}
        >
          <GitBranch size={18} />
          <span>创作流程</span>
        </button>
      </nav>
      <div className="side-scroll">
        <section className="side-section">
          <div className="section-heading">
            <span>最近项目</span>
            <IconButton
              label="查看所有项目"
              onClick={() => setPage("projects")}
            >
              <Plus size={14} />
            </IconButton>
          </div>
          {projects.length === 0 && (
            <p className="side-empty">把一个想法，写成作品。</p>
          )}
          {[...projects]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 6)
            .map((project) => (
              <button
                type="button"
                className={`project-link ${page === "creation" && project.id === activeProjectId ? "active" : ""}`}
                key={project.id}
                onClick={() => {
                  useCreationStore.getState().open(project.id);
                  setPage("creation");
                }}
              >
                <BookOpen size={14} />
                <span>{project.name}</span>
              </button>
            ))}
        </section>
        <section className="side-section">
          <div className="section-heading">
            <span>最近对话</span>
            <IconButton label="新对话" onClick={newChat}>
              <Plus size={14} />
            </IconButton>
          </div>
          {loading && <p className="side-empty">加载会话中…</p>}
          {loadError && (
            <button
              type="button"
              className="side-error"
              onClick={() => void loadConversations()}
            >
              {loadError} · 重试
            </button>
          )}
          {!loading && !loadError && history.length === 0 && (
            <p className="side-empty">
              {user ? "从一段新对话开始。" : "登录后查看历史对话。"}
            </p>
          )}
          {history.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              className={`history-link ${page === "workbench" && activeId === conversation.id ? "active" : ""}`}
              onClick={() => {
                setActive(conversation.id);
                setPage("workbench");
              }}
              title={conversation.title}
            >
              {conversation.title}
            </button>
          ))}
        </section>
      </div>
      <div className="side-bottom">
        <button
          type="button"
          className="account"
          onClick={() => setPage(user ? "settings" : "login")}
        >
          <span className="account-avatar">
            {user?.nickname.charAt(0) || "S"}
          </span>
          <span>
            <strong>{user?.nickname || "未登录"}</strong>
            <small>{user ? "账号已连接" : "登录以使用 AI"}</small>
          </span>
        </button>
        <IconButton label="设置" onClick={() => setPage("settings")}>
          <Settings size={17} />
        </IconButton>
      </div>
    </aside>
  );
}
