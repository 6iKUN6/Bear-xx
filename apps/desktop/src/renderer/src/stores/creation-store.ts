import { create } from "zustand";
import {
  applyProposal,
  createProject,
  newChapter,
  parseProjects,
  serializeProjects,
  undoProposal,
  type Chapter,
  type CreationProject,
  type WritingProposal,
} from "@/lib/creation";

export const PROJECT_STORAGE_KEY = "sola_desktop_creation_projects_v1";
export type CreationStage = "settings" | "outline" | "writing" | "flow";

interface CreationState {
  projects: CreationProject[];
  hydrated: boolean;
  storageBlocked: boolean;
  dirty: boolean;
  error: string | null;
  activeProjectId: string | null;
  chapterByProject: Record<string, string>;
  stage: CreationStage;
  assistantOpen: boolean;
  drafts: Record<string, string>;
  proposals: Record<string, WritingProposal | undefined>;
  hydrate: () => void;
  flush: () => boolean;
  create: (name: string, genre: string, brief: string) => string;
  open: (id: string) => void;
  update: (
    id: string,
    patch: Partial<
      Pick<
        CreationProject,
        "name" | "genre" | "brief" | "style" | "characters" | "agentId"
      >
    >,
  ) => void;
  remove: (id: string) => void;
  bindConversation: (
    id: string,
    userId: string,
    conversationId: string | null,
  ) => void;
  selectChapter: (projectId: string, chapterId: string) => void;
  addChapter: (projectId: string) => void;
  updateChapter: (
    projectId: string,
    chapterId: string,
    patch: Partial<Pick<Chapter, "title" | "outline" | "content">>,
  ) => void;
  removeChapter: (projectId: string, chapterId: string) => void;
  setStage: (stage: CreationStage) => void;
  toggleAssistant: () => void;
  setDraft: (id: string, value: string) => void;
  setProposal: (id: string, proposal: WritingProposal | undefined) => void;
  adopt: (projectId: string, id: string) => void;
  undo: (projectId: string, id: string) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useCreationStore = create<CreationState>((set, get) => {
  function change(projects: CreationProject[]) {
    if (get().storageBlocked)
      throw new Error("本机项目尚未成功读取，已停止写入以保留原数据。");
    set({ projects, dirty: true });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => get().flush(), 450);
  }
  function updateProject(
    id: string,
    update: (project: CreationProject) => CreationProject,
  ) {
    if (!get().projects.some((project) => project.id === id)) return;
    change(
      get().projects.map((project) =>
        project.id === id
          ? { ...update(project), updatedAt: Date.now() }
          : project,
      ),
    );
  }
  return {
    projects: [],
    hydrated: false,
    storageBlocked: false,
    dirty: false,
    error: null,
    activeProjectId: null,
    chapterByProject: {},
    stage: "writing",
    assistantOpen: true,
    drafts: {},
    proposals: {},
    hydrate() {
      if (get().hydrated && !get().storageBlocked) return;
      try {
        set({
          projects: parseProjects(localStorage.getItem(PROJECT_STORAGE_KEY)),
          hydrated: true,
          storageBlocked: false,
          error: null,
        });
      } catch (error) {
        set({
          hydrated: true,
          storageBlocked: true,
          error: error instanceof Error ? error.message : "读取本机项目失败",
        });
      }
    },
    flush() {
      clearTimeout(saveTimer);
      if (get().storageBlocked) return false;
      if (!get().dirty) return true;
      try {
        localStorage.setItem(
          PROJECT_STORAGE_KEY,
          serializeProjects(get().projects),
        );
        set({ dirty: false, error: null });
        return true;
      } catch {
        set({
          error:
            "保存到本机失败，可能是存储空间不足。当前内容仍在窗口内，请先导出备份。",
        });
        return false;
      }
    },
    create(name, genre, brief) {
      const project = createProject(name, genre, brief);
      change([project, ...get().projects]);
      set({
        activeProjectId: project.id,
        stage: "settings",
        chapterByProject: {
          ...get().chapterByProject,
          [project.id]: project.chapters[0].id,
        },
      });
      return project.id;
    },
    open(id) {
      set({ activeProjectId: id });
    },
    update(id, patch) {
      updateProject(id, (project) => ({ ...project, ...patch }));
    },
    remove(id) {
      change(get().projects.filter((project) => project.id !== id));
      set({
        activeProjectId:
          get().activeProjectId === id ? null : get().activeProjectId,
      });
    },
    bindConversation(id, userId, conversationId) {
      updateProject(id, (project) => {
        const conversations = { ...project.conversations };
        if (conversationId === null) delete conversations[userId];
        else conversations[userId] = conversationId;
        return { ...project, conversations };
      });
    },
    selectChapter(projectId, chapterId) {
      set({
        chapterByProject: { ...get().chapterByProject, [projectId]: chapterId },
      });
    },
    addChapter(projectId) {
      const project = get().projects.find((item) => item.id === projectId);
      if (!project) return;
      const chapter = newChapter(project.chapters.length + 1);
      updateProject(projectId, (item) => ({
        ...item,
        chapters: [...item.chapters, chapter],
      }));
      get().selectChapter(projectId, chapter.id);
    },
    updateChapter(projectId, chapterId, patch) {
      updateProject(projectId, (project) => ({
        ...project,
        chapters: project.chapters.map((chapter) =>
          chapter.id === chapterId ? { ...chapter, ...patch } : chapter,
        ),
      }));
    },
    removeChapter(projectId, chapterId) {
      updateProject(projectId, (project) => ({
        ...project,
        chapters: project.chapters.filter(
          (chapter) => chapter.id !== chapterId,
        ),
      }));
    },
    setStage(stage) {
      set({ stage });
    },
    toggleAssistant() {
      set({ assistantOpen: !get().assistantOpen });
    },
    setDraft(id, value) {
      set({ drafts: { ...get().drafts, [id]: value } });
    },
    setProposal(id, proposal) {
      set({ proposals: { ...get().proposals, [id]: proposal } });
    },
    adopt(projectId, id) {
      const proposal = get().proposals[id];
      const chapter = get()
        .projects.find((project) => project.id === projectId)
        ?.chapters.find((item) => item.id === proposal?.target.chapterId);
      if (!proposal || !chapter || !projectId)
        throw new Error("对应章节已不存在。");
      const content = applyProposal(chapter, proposal);
      get().updateChapter(projectId, chapter.id, { content });
      get().setProposal(id, { ...proposal, appliedContent: content });
    },
    undo(projectId, id) {
      const proposal = get().proposals[id];
      const chapter = get()
        .projects.find((project) => project.id === projectId)
        ?.chapters.find((item) => item.id === proposal?.target.chapterId);
      if (!proposal || !chapter || !projectId)
        throw new Error("对应章节已不存在。");
      get().updateChapter(projectId, chapter.id, {
        content: undoProposal(chapter, proposal),
      });
      get().setProposal(id, { ...proposal, appliedContent: undefined });
    },
  };
});
