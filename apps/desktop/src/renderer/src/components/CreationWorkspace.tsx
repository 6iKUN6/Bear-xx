import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronRight,
  Download,
  FileText,
  GitBranch,
  List,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  PanelRightOpen,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useCreationStore, type CreationStage } from "@/stores/creation-store";
import {
  downloadText,
  projectText,
  serializeProjects,
  wordCount,
  type CreationProject,
  type EditTarget,
} from "@/lib/creation";
import { CreationAssistant } from "./CreationAssistant";
import { FlowsPage } from "./FlowsPage";
import { Button, IconButton, Modal } from "./ui";

const stages: { id: CreationStage; label: string; icon: typeof FileText }[] = [
  { id: "settings", label: "设定与人物", icon: Users },
  { id: "outline", label: "章节大纲", icon: List },
  { id: "writing", label: "正文创作", icon: FileText },
  { id: "flow", label: "创作流程", icon: GitBranch },
];

export function CreationWorkspace() {
  const store = useCreationStore();
  const project = store.projects.find(
    (item) => item.id === store.activeProjectId,
  );
  const [settings, setSettings] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleteChapterId, setDeleteChapterId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [fontSize, setFontSize] = useState(18);
  const [selection, setSelection] = useState<EditTarget | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const chapter =
    project?.chapters.find(
      (item) => item.id === store.chapterByProject[project.id],
    ) ?? project?.chapters[0];
  useEffect(() => {
    setSelection(null);
  }, [chapter?.id]);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.style.height = "auto";
    editor.style.height = `${Math.max(editor.scrollHeight, 420)}px`;
  }, [
    chapter?.content,
    chapter?.id,
    fontSize,
    store.stage,
    store.assistantOpen,
    outlineOpen,
  ]);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let lastWidth = editor.clientWidth;
    const observer = new ResizeObserver(() => {
      if (editor.clientWidth === lastWidth) return;
      lastWidth = editor.clientWidth;
      editor.style.height = "auto";
      editor.style.height = `${Math.max(editor.scrollHeight, 420)}px`;
    });
    observer.observe(editor);
    return () => observer.disconnect();
  }, [chapter?.id, store.stage]);
  if (!project)
    return (
      <main className="project-empty flex-1">
        <BookOpen size={30} />
        <h2>选择一个项目开始创作</h2>
        <Button onClick={() => useAppStore.getState().setPage("projects")}>
          查看我的项目
        </Button>
      </main>
    );
  const chapterId = chapter?.id;
  const words = project.chapters.reduce(
    (count, item) => count + wordCount(item.content),
    0,
  );
  return (
    <main className="creation-page">
      <header className="workspace-heading">
        <div className="breadcrumb">
          <button
            type="button"
            onClick={() => useAppStore.getState().setPage("projects")}
          >
            创作
          </button>
          <ChevronRight size={13} />
          <BookOpen size={14} />
          <strong>{project.name || "未命名作品"}</strong>
          <span className="pill">{project.genre}</span>
        </div>
        <div className="workspace-actions">
          <span className={`save-status ${store.error ? "failed" : ""}`}>
            {store.error ? (
              "保存失败"
            ) : store.dirty ? (
              "保存中…"
            ) : (
              <>
                <Check size={12} />
                已保存到本机
              </>
            )}
          </span>
          <IconButton label="项目设置" onClick={() => setSettings(true)}>
            <Settings2 size={16} />
          </IconButton>
          <Button onClick={() => setExporting(true)}>
            <Download size={14} />
            导出
          </Button>
        </div>
      </header>
      <nav className="stage-nav" aria-label="创作阶段">
        {stages.map(({ id, label, icon: Icon }, index) => (
          <button
            type="button"
            key={id}
            className={store.stage === id ? "active" : ""}
            aria-current={store.stage === id ? "step" : undefined}
            onClick={() => store.setStage(id)}
          >
            <span className="stage-number">0{index + 1}</span>
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div
        className={`creation-body ${store.assistantOpen && store.stage !== "flow" ? "with-assistant" : ""}`}
      >
        <div className="creation-main">
          {store.stage === "settings" && (
            <div className="creation-form page-scroll">
              <p className="eyebrow">THE WORLD OF YOUR STORY</p>
              <h1>每个好故事，都有自己的世界。</h1>
              <p className="muted mb-8">
                把重要的设定留在这里，创作助手会以此作为上下文。
              </p>
              <label className="field">
                故事简介与世界观
                <textarea
                  rows={6}
                  value={project.brief}
                  onChange={(event) =>
                    store.update(project.id, { brief: event.target.value })
                  }
                  placeholder="故事发生在哪里？世界遵循什么规则？主角想要什么，又被什么阻挡？"
                />
              </label>
              <label className="field">
                人物档案
                <textarea
                  rows={8}
                  value={project.characters}
                  onChange={(event) =>
                    store.update(project.id, { characters: event.target.value })
                  }
                  placeholder="人物姓名、身份、动机、关系与不为人知的秘密…"
                />
              </label>
              <label className="field">
                写作风格
                <textarea
                  rows={4}
                  value={project.style}
                  onChange={(event) =>
                    store.update(project.id, { style: event.target.value })
                  }
                  placeholder="叙事视角、语言风格、节奏，以及希望避免的表达…"
                />
              </label>
              <div className="form-footer">
                <span className="muted">这些内容可以随创作继续完善。</span>
                <Button onClick={() => store.setStage("outline")}>
                  下一步：章节大纲
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          )}
          {store.stage === "outline" && (
            <div className="creation-form page-scroll">
              <div className="outline-page-heading">
                <div>
                  <p className="eyebrow">A MAP FOR YOUR STORY</p>
                  <h1>给故事一条前进的线索。</h1>
                  <p className="muted">先安排转折与变化，再逐章展开。</p>
                </div>
                <Button onClick={() => store.addChapter(project.id)}>
                  <Plus size={14} />
                  添加章节
                </Button>
              </div>
              <div className="outline-cards">
                {project.chapters.map((item, index) => (
                  <section className="outline-card" key={item.id}>
                    <div className="outline-card-heading">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <input
                        aria-label={`第 ${index + 1} 章标题`}
                        maxLength={100}
                        value={item.title}
                        onChange={(event) =>
                          store.updateChapter(project.id, item.id, {
                            title: event.target.value,
                          })
                        }
                      />
                      <IconButton
                        label={`删除${item.title}`}
                        onClick={() => setDeleteChapterId(item.id)}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                    <textarea
                      aria-label={`${item.title}大纲`}
                      rows={4}
                      value={item.outline}
                      onChange={(event) =>
                        store.updateChapter(project.id, item.id, {
                          outline: event.target.value,
                        })
                      }
                      placeholder="这一章发生了什么？人物面对什么选择？结尾留下怎样的悬念？"
                    />
                    <div className="outline-card-footer">
                      <span>
                        {wordCount(item.content).toLocaleString()} 字正文
                      </span>
                      <Button
                        variant="quiet"
                        onClick={() => {
                          store.selectChapter(project.id, item.id);
                          store.setStage("writing");
                        }}
                      >
                        开始写这一章
                        <ChevronRight size={13} />
                      </Button>
                    </div>
                  </section>
                ))}
              </div>
              {project.chapters.length === 0 && (
                <div className="project-empty">
                  <List size={26} />
                  <h2>还没有章节</h2>
                  <Button onClick={() => store.addChapter(project.id)}>
                    添加第一章
                  </Button>
                </div>
              )}
            </div>
          )}
          {store.stage === "flow" && <FlowsPage project={project} />}
          {store.stage === "writing" && (
            <div
              className={`writing-workspace ${outlineOpen ? "with-outline" : ""}`}
            >
              {outlineOpen && (
                <aside className="chapter-outline">
                  <div className="outline-heading">
                    <strong>章节目录</strong>
                    <IconButton
                      label="添加章节"
                      onClick={() => store.addChapter(project.id)}
                    >
                      <Plus size={15} />
                    </IconButton>
                  </div>
                  <div className="chapter-list">
                    {project.chapters.map((item, index) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`chapter-item ${item.id === chapterId ? "active" : ""}`}
                        onClick={() => store.selectChapter(project.id, item.id)}
                      >
                        <span className="chapter-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span>
                          <strong>{item.title || "未命名章节"}</strong>
                          <small>
                            {wordCount(item.content).toLocaleString()} 字
                          </small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="add-chapter"
                    onClick={() => store.addChapter(project.id)}
                  >
                    <Plus size={14} />
                    添加章节
                  </button>
                  <div className="outline-total">
                    共 {project.chapters.length} 章 · {words.toLocaleString()}{" "}
                    字
                  </div>
                </aside>
              )}
              <div className="editor-panel">
                <div className="editor-toolbar">
                  <IconButton
                    label={outlineOpen ? "收起章节目录" : "展开章节目录"}
                    aria-pressed={outlineOpen}
                    onClick={() => setOutlineOpen(!outlineOpen)}
                  >
                    <List size={16} />
                  </IconButton>
                  <span>正文</span>
                  <div className="editor-tools">
                    <label>
                      字号
                      <select
                        aria-label="正文字号"
                        value={fontSize}
                        onChange={(event) =>
                          setFontSize(Number(event.target.value))
                        }
                      >
                        {[16, 18, 20, 22].map((size) => (
                          <option value={size} key={size}>
                            {size}
                          </option>
                        ))}
                      </select>
                    </label>
                    {chapter && (
                      <IconButton
                        label="删除当前章节"
                        onClick={() => setDeleteChapterId(chapter.id)}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    )}
                    <IconButton
                      label={
                        store.assistantOpen ? "收起创作助手" : "打开创作助手"
                      }
                      aria-pressed={store.assistantOpen}
                      onClick={store.toggleAssistant}
                    >
                      <PanelRightOpen size={16} />
                    </IconButton>
                  </div>
                </div>
                {chapter ? (
                  <div className="editor-scroll">
                    <article className="manuscript">
                      <p className="eyebrow">
                        CHAPTER{" "}
                        {String(project.chapters.indexOf(chapter) + 1).padStart(
                          2,
                          "0",
                        )}
                      </p>
                      <input
                        className="chapter-title"
                        aria-label="当前章节标题"
                        maxLength={100}
                        value={chapter.title}
                        onChange={(event) =>
                          store.updateChapter(project.id, chapter.id, {
                            title: event.target.value,
                          })
                        }
                        placeholder="章节标题"
                      />
                      <div className="chapter-meta">
                        <span>
                          {wordCount(chapter.content).toLocaleString()} 字
                        </span>
                        <span>自由写作 · 自动保存</span>
                      </div>
                      {chapter.outline && (
                        <details className="chapter-brief">
                          <summary>本章大纲</summary>
                          <p>{chapter.outline}</p>
                        </details>
                      )}
                      <textarea
                        ref={editorRef}
                        className="manuscript-input"
                        style={{ fontSize }}
                        aria-label="章节正文"
                        value={chapter.content}
                        onChange={(event) =>
                          store.updateChapter(project.id, chapter.id, {
                            content: event.target.value,
                          })
                        }
                        onSelect={(event) => {
                          const { selectionStart, selectionEnd } =
                            event.currentTarget;
                          setSelection(
                            selectionEnd > selectionStart
                              ? {
                                  chapterId: chapter.id,
                                  before: chapter.content,
                                  start: selectionStart,
                                  end: selectionEnd,
                                }
                              : null,
                          );
                        }}
                        placeholder={
                          "故事从这里开始。\n\n写下第一句话，或打开创作助手，根据大纲一起打磨这一章。"
                        }
                      />
                    </article>
                  </div>
                ) : (
                  <div className="project-empty">
                    <FileText size={30} />
                    <h2>新的一章，新的开始</h2>
                    <Button onClick={() => store.addChapter(project.id)}>
                      <Plus size={14} />
                      添加章节
                    </Button>
                  </div>
                )}
                <footer className="editor-status">
                  <span>
                    {selection && selection.before === chapter?.content
                      ? `已选中 ${selection.end - selection.start} 字符，可让助手改写`
                      : "选中一段文字，与助手一起打磨"}
                  </span>
                  <span>本机项目</span>
                </footer>
              </div>
            </div>
          )}
        </div>
        {store.assistantOpen && store.stage !== "flow" && (
          <CreationAssistant
            key={project.id}
            project={project}
            chapter={chapter}
            selection={selection}
          />
        )}
        {!store.assistantOpen && store.stage !== "flow" && (
          <Button className="open-assistant" onClick={store.toggleAssistant}>
            <Sparkles size={15} />
            创作助手
          </Button>
        )}
      </div>
      {settings && (
        <ProjectSettings project={project} onClose={() => setSettings(false)} />
      )}
      {exporting && (
        <Modal title="导出作品" onClose={() => setExporting(false)}>
          <p className="muted mb-5">
            共 {project.chapters.length} 章，{words.toLocaleString()}{" "}
            字。正文导出包含章节标题。
          </p>
          <div className="export-options">
            <Button
              onClick={() => {
                downloadText(`${project.name}.txt`, projectText(project));
                setExporting(false);
              }}
            >
              <FileText size={17} />
              纯文本 .txt
            </Button>
            <Button
              onClick={() => {
                downloadText(
                  `${project.name}.md`,
                  `# ${project.name}\n\n${project.chapters.map((item) => `## ${item.title}\n\n${item.content}`).join("\n\n")}`,
                );
                setExporting(false);
              }}
            >
              <FileText size={17} />
              Markdown .md
            </Button>
            <Button
              onClick={() => {
                downloadText(
                  `${project.name}-项目备份.json`,
                  serializeProjects([project]),
                  "application/json",
                );
                setExporting(false);
              }}
            >
              <Download size={17} />
              完整项目备份 .json
            </Button>
          </div>
        </Modal>
      )}
      {deleteChapterId && (
        <Modal title="删除章节" onClose={() => setDeleteChapterId(null)}>
          <p>
            确定删除「
            {
              project.chapters.find((item) => item.id === deleteChapterId)
                ?.title
            }
            」及其正文和大纲？删除后无法撤销。
          </p>
          <div className="modal-actions">
            <Button onClick={() => setDeleteChapterId(null)}>保留章节</Button>
            <Button
              variant="danger"
              onClick={() => {
                store.removeChapter(project.id, deleteChapterId);
                setDeleteChapterId(null);
              }}
            >
              删除章节
            </Button>
          </div>
        </Modal>
      )}
    </main>
  );
}

function ProjectSettings({
  project,
  onClose,
}: {
  project: CreationProject;
  onClose: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useCreationStore((s) => s.update);
  return (
    <Modal title="项目设置" onClose={onClose}>
      <label className="field">
        作品名称
        <input
          required
          maxLength={80}
          value={project.name}
          onChange={(event) => update(project.id, { name: event.target.value })}
          onBlur={() => {
            if (!project.name.trim())
              update(project.id, { name: "未命名作品" });
          }}
        />
      </label>
      <label className="field">
        故事类型
        <input
          maxLength={30}
          value={project.genre}
          onChange={(event) =>
            update(project.id, { genre: event.target.value })
          }
        />
      </label>
      <p className="local-footnote">
        保存在当前设备，与账号登录状态无关。可随时导出完整备份。
      </p>
      <div className="project-danger">
        {confirmDelete ? (
          <>
            <p>删除「{project.name}」及其所有章节？此操作无法撤销。</p>
            <div className="modal-actions">
              <Button onClick={() => setConfirmDelete(false)}>取消</Button>
              <Button
                variant="danger"
                onClick={() => {
                  useCreationStore.getState().remove(project.id);
                  useAppStore.getState().setPage("projects");
                  onClose();
                }}
              >
                确认删除项目
              </Button>
            </div>
          </>
        ) : (
          <Button variant="quiet" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} />
            删除本机项目
          </Button>
        )}
      </div>
      <div className="modal-actions">
        <Button onClick={onClose}>完成</Button>
      </div>
    </Modal>
  );
}
