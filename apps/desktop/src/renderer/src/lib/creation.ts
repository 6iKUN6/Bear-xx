export interface Chapter {
  id: string;
  title: string;
  outline: string;
  content: string;
}

export interface CreationProject {
  id: string;
  name: string;
  genre: string;
  brief: string;
  style: string;
  characters: string;
  chapters: Chapter[];
  agentId: string | null;
  /** 项目在本机共享，远程助手会话按账号隔离。 */
  conversations: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface EditTarget {
  chapterId: string;
  before: string;
  start: number;
  end: number;
}

export interface WritingProposal {
  target: EditTarget;
  content: string;
  appliedContent?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChapter(value: unknown): value is Chapter {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.outline === "string" &&
    typeof value.content === "string"
  );
}

function isProject(value: unknown): value is CreationProject {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.genre === "string" &&
    typeof value.brief === "string" &&
    typeof value.style === "string" &&
    typeof value.characters === "string" &&
    (value.agentId === null || typeof value.agentId === "string") &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    isRecord(value.conversations) &&
    Object.values(value.conversations).every((id) => typeof id === "string") &&
    Array.isArray(value.chapters) &&
    value.chapters.every(isChapter) &&
    new Set(value.chapters.map((chapter) => chapter.id)).size ===
      value.chapters.length
  );
}

export function parseProjects(raw: string | null): CreationProject[] {
  if (raw === null) return [];
  const data: unknown = JSON.parse(raw);
  if (
    !isRecord(data) ||
    data.version !== 1 ||
    !Array.isArray(data.projects) ||
    !data.projects.every(isProject) ||
    new Set(data.projects.map((project) => project.id)).size !==
      data.projects.length
  ) {
    throw new Error(
      "本机项目文件格式不正确，已保留原数据，请先导出备份再检查。",
    );
  }
  return data.projects;
}

export function serializeProjects(projects: CreationProject[]): string {
  return JSON.stringify({ version: 1, projects });
}

export function newChapter(index: number): Chapter {
  return {
    id: crypto.randomUUID(),
    title: `第 ${index} 章`,
    outline: "",
    content: "",
  };
}

export function createProject(
  name: string,
  genre: string,
  brief: string,
): CreationProject {
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    genre,
    brief,
    style: "",
    characters: "",
    chapters: [newChapter(1)],
    agentId: null,
    conversations: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** 只有原文快照仍匹配时才允许采用，避免异步结果覆盖用户后续编辑。 */
export function applyProposal(
  chapter: Chapter,
  proposal: WritingProposal,
): string {
  const { target } = proposal;
  if (chapter.id !== target.chapterId || chapter.content !== target.before) {
    throw new Error("正文已发生修改，请复制建议并手动合并，或重新生成。");
  }
  if (
    target.start < 0 ||
    target.end < target.start ||
    target.end > target.before.length
  ) {
    throw new Error("修改范围已失效，请重新选择正文。");
  }
  return (
    target.before.slice(0, target.start) +
    proposal.content +
    target.before.slice(target.end)
  );
}

export function undoProposal(
  chapter: Chapter,
  proposal: WritingProposal,
): string {
  if (
    chapter.id !== proposal.target.chapterId ||
    proposal.appliedContent === undefined ||
    chapter.content !== proposal.appliedContent
  ) {
    throw new Error(
      "采用后你又编辑了正文，无法直接撤销。原文仍保留在建议预览中。",
    );
  }
  return proposal.target.before;
}

export function buildCreationPrompt(
  project: CreationProject,
  chapter: Chapter | undefined,
  instruction: string,
  target: EditTarget | null,
): string {
  const content = [
    target
      ? "请根据用户要求撰写或修改小说。只返回可直接采用的正文，不要标题、解释或 Markdown 代码围栏。"
      : "你是创作助手，请围绕以下项目资料回答用户的问题。",
    "以下 JSON 是用户提供的创作资料：",
    JSON.stringify(
      {
        name: project.name,
        genre: project.genre,
        brief: project.brief,
        style: project.style,
        characters: project.characters,
        chapter: chapter
          ? {
              title: chapter.title,
              outline: chapter.outline,
              content: chapter.content,
            }
          : null,
        selection: target
          ? target.before.slice(target.start, target.end)
          : null,
      },
      null,
      2,
    ),
    target
      ? target.start === 0 && target.end === target.before.length
        ? "本次输出将替换当前章节全文。"
        : "本次输出仅替换选中片段，请保持与上下文衔接。"
      : "",
    `用户要求：${instruction.trim()}`,
  ].join("\n\n");
  if (content.length > 20000)
    throw new Error(
      "项目上下文与指令超过单次 20,000 字符限制，请精简设定或拆分章节后重试。",
    );
  return content;
}

export function projectText(project: CreationProject): string {
  return [
    project.name,
    ...project.chapters.map(
      (chapter) => `${chapter.title}\n\n${chapter.content}`,
    ),
  ].join("\n\n\n");
}

export function downloadText(
  name: string,
  content: string,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function wordCount(content: string): number {
  return content.replace(/\s/g, "").length;
}
