import { useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Film,
  Plus,
  Search,
  HardDrive,
} from "lucide-react";
import { useCreationStore } from "@/stores/creation-store";
import { useAppStore } from "@/stores/app-store";
import { wordCount } from "@/lib/creation";
import { Button, Modal, Notice } from "./ui";

export function ProjectsPage() {
  const projects = useCreationStore((s) => s.projects);
  const blocked = useCreationStore((s) => s.storageBlocked);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = [...projects]
    .filter((project) =>
      project.name.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <main className="projects-page page-scroll">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR CREATIVE SPACE</p>
          <h1>让想法，成为作品。</h1>
          <p className="muted">从故事设定到最后一章，在一个地方持续创作。</p>
        </div>
        <Button
          variant="primary"
          onClick={() => setCreating(true)}
          disabled={blocked}
        >
          <Plus size={16} />
          新建项目
        </Button>
      </div>
      <div className="creation-types">
        <div className="creation-type active">
          <BookOpen size={19} />
          <span>
            <strong>小说创作</strong>
            <small>设定 · 大纲 · 正文</small>
          </span>
        </div>
        <div className="creation-type muted">
          <Film size={19} />
          <span>
            <strong>视频创作</strong>
            <small>筹备中</small>
          </span>
        </div>
      </div>
      <div className="projects-heading">
        <h2>
          我的项目 <span>{projects.length}</span>
        </h2>
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="搜索项目"
            placeholder="搜索项目…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {filtered.length > 0 ? (
        <div className="project-grid">
          {filtered.map((project) => (
            <button
              type="button"
              className="project-card"
              key={project.id}
              onClick={() => {
                useCreationStore.getState().open(project.id);
                useAppStore.getState().setPage("creation");
              }}
            >
              <div className="project-card-top">
                <span className="book-icon">
                  <BookOpen size={24} strokeWidth={1.4} />
                </span>
                <ArrowUpRight size={17} />
              </div>
              <span className="eyebrow">{project.genre || "小说"}</span>
              <h3>{project.name}</h3>
              <p>{project.brief || "还没有简介，进入项目写下你的故事想法。"}</p>
              <div className="project-card-bottom">
                <span>
                  {project.chapters.length} 章 ·{" "}
                  {project.chapters
                    .reduce(
                      (sum, chapter) => sum + wordCount(chapter.content),
                      0,
                    )
                    .toLocaleString()}{" "}
                  字
                </span>
                <span>
                  {new Date(project.updatedAt).toLocaleDateString("zh-CN", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="project-empty">
          <BookOpen size={34} strokeWidth={1.2} />
          <h2>{search ? "没有找到相关项目" : "你的第一部作品，从这里开始"}</h2>
          <p>
            {search
              ? "试试其他名称。"
              : "先写下一个故事的名字，世界和人物可以慢慢生长。"}
          </p>
          {!search && (
            <Button
              variant="primary"
              onClick={() => setCreating(true)}
              disabled={blocked}
            >
              <Plus size={15} />
              创建小说项目
            </Button>
          )}
        </div>
      )}
      <p className="local-footnote">
        <HardDrive size={13} />
        项目保存在本机，编辑无需联网。AI 生成需登录并连接服务。
      </p>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </main>
  );
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [genre, setGenre] = useState("小说");
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal title="新建小说项目" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          try {
            useCreationStore.getState().create(name, genre, brief);
            useAppStore.getState().setPage("creation");
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : "创建失败");
          }
        }}
      >
        <p className="muted mb-6">给故事一个起点，其他细节可以随时调整。</p>
        <label className="field">
          作品名称
          <input
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="为你的故事起个名字"
          />
        </label>
        <label className="field">
          故事类型
          <select
            value={genre}
            onChange={(event) => setGenre(event.target.value)}
          >
            {[
              "小说",
              "科幻",
              "奇幻",
              "悬疑",
              "现实",
              "言情",
              "历史",
              "其他",
            ].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="field">
          一句话灵感 <small>可选</small>
          <textarea
            rows={3}
            maxLength={4000}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="一个什么样的人，遇到了什么不同寻常的事？"
          />
        </label>
        {error && <Notice>{error}</Notice>}
        <div className="modal-actions">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" disabled={!name.trim()}>
            创建项目
            <ArrowUpRight size={14} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
