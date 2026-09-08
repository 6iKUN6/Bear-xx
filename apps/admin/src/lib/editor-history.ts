import type { EditableDefinition } from "./flow-edit";

/**
 * 画布编辑器的撤销/重做栈
 * @description 快照式：flow-edit 的每个操作都是纯函数返回新定义，快照直接存引用即可，
 * 没有拷贝开销。只在内存中存活，不持久化——刷新页面即放弃历史，与「改动只在本地，
 * 点保存才落库」的语义一致。
 */

/** 历史上限：超出后丢弃最旧的快照，避免长编辑session堆内存 */
export const HISTORY_LIMIT = 50;

export interface EditorHistory {
  /** 撤销栈：栈底 → 栈顶（最近一次提交的前一个草稿） */
  past: EditableDefinition[];
  /** 重做栈：栈顶在最近撤销的一步；任何新提交都会清空它 */
  future: EditableDefinition[];
}

export const EMPTY_HISTORY: EditorHistory = { past: [], future: [] };

/**
 * 提交一次编辑前的快照
 * @param history 当前历史
 * @param snapshot 编辑发生前的草稿
 * @returns 返回追加后的新历史（future 清空：时间线已分叉）
 */
export function pushHistory(
  history: EditorHistory,
  snapshot: EditableDefinition,
): EditorHistory {
  return {
    past: [...history.past.slice(-(HISTORY_LIMIT - 1)), snapshot],
    future: [],
  };
}

/**
 * 撤销一步
 * @param history 当前历史
 * @param current 当前草稿（压入重做栈）
 * @returns 返回新历史与恢复出的草稿；无可撤销时返回 null
 */
export function undoHistory(
  history: EditorHistory,
  current: EditableDefinition,
): { history: EditorHistory; draft: EditableDefinition } | null {
  const previous = history.past.at(-1);
  if (!previous) {
    return null;
  }
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future],
    },
    draft: previous,
  };
}

/**
 * 重做一步
 * @param history 当前历史
 * @param current 当前草稿（压回撤销栈）
 * @returns 返回新历史与恢复出的草稿；无可重做时返回 null
 */
export function redoHistory(
  history: EditorHistory,
  current: EditableDefinition,
): { history: EditorHistory; draft: EditableDefinition } | null {
  const next = history.future[0];
  if (!next) {
    return null;
  }
  return {
    history: {
      past: [...history.past, current],
      future: history.future.slice(1),
    },
    draft: next,
  };
}
