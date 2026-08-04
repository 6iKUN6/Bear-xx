import * as storage from "../../utils/storage";
import { STORAGE_KEYS } from "../../utils/constants";

/** 会话的未完成流式任务指针：跨页面/重启后据此续接 SSE */
export interface PendingStreamTask {
  taskId: string;
  savedAt: number;
}

/** 超过后端恢复窗口太久的指针视为过期垃圾，读取时顺手清理 */
const PENDING_TASK_MAX_AGE_MS = 60 * 60 * 1000;

type PendingTaskMap = Record<string, PendingStreamTask>;

function readMap(): PendingTaskMap {
  return storage.get<PendingTaskMap>(STORAGE_KEYS.PENDING_STREAM_TASKS) ?? {};
}

function writeMap(map: PendingTaskMap) {
  storage.set(STORAGE_KEYS.PENDING_STREAM_TASKS, map);
}

/** 记录会话的进行中任务（task.created 时调用） */
export function savePendingTask(conversationId: string, taskId: string) {
  const map = readMap();
  map[conversationId] = { taskId, savedAt: Date.now() };
  writeMap(map);
}

/** 读取会话的未完成任务指针；过期条目静默清理 */
export function getPendingTask(
  conversationId: string,
): PendingStreamTask | null {
  const map = readMap();
  const pending = map[conversationId];
  if (!pending) {
    return null;
  }
  if (Date.now() - pending.savedAt > PENDING_TASK_MAX_AGE_MS) {
    clearPendingTask(conversationId);
    return null;
  }
  return pending;
}

/** 任务终态（完成/失败/取消）时清除指针 */
export function clearPendingTask(conversationId: string) {
  const map = readMap();
  if (map[conversationId]) {
    delete map[conversationId];
    writeMap(map);
  }
}
