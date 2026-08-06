import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalDecision } from "@litter-bear/types/protocol";
import { streamTaskService } from "../services/stream";
import type {
  ChatStreamInput,
  StreamTaskHandle,
  StreamTaskLifecycle,
  StreamTaskSnapshot,
  StreamTaskStartOptions,
} from "../services/stream";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 800;

type StreamStarter = (lifecycle: StreamTaskLifecycle) => StreamTaskHandle;

/**
 * 比较两个 Redis Stream 帧 id
 * @returns a > b 返回正数，相等返回 0，a < b 返回负数
 * @description 帧 id 形如 `1738913000123-0`（毫秒-序号），必须按两段数值比较：
 * 字符串比较会把 "10-0" 判为小于 "9-0"。非法/缺失 id 视为最小值。
 */
function compareEventId(a: string, b: string): number {
  const [aMs = 0, aSeq = 0] = a.split("-").map(Number);
  const [bMs = 0, bSeq = 0] = b.split("-").map(Number);
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) {
    return 0;
  }
  return aMs !== bMs ? aMs - bMs : aSeq - bSeq;
}

const initialSnapshot: StreamTaskSnapshot = {
  status: "idle",
  task: null,
  error: null,
  retryCount: 0,
  lastEventId: "0",
};

export function useStreamTask(options: StreamTaskStartOptions = {}) {
  const [snapshot, setSnapshot] = useState<StreamTaskSnapshot>(initialSnapshot);
  const handleRef = useRef<StreamTaskHandle | null>(null);
  const taskIdRef = useRef<string>("");
  const lastEventIdRef = useRef("0");
  /**
   * 已应用过的最大帧 id（跨连接共享）
   * @description 与 lastEventIdRef 的区别：lastEventId 是"续传游标"（发给服务端），
   * 这里是"幂等游标"（本地判重）。同一任务的首轮流与审批/恢复流共用它，
   * 因此 resume/submitApproval 时**不能重置**，否则重复帧会重新放行。
   */
  const appliedEventIdRef = useRef("");
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRetryRef = useRef<(fallbackError?: Error) => boolean>(
    () => false,
  );
  const lifecycleRef = useRef<StreamTaskLifecycle>({});
  const mountedRef = useRef(true);
  const startOptionsRef = useRef(options);
  startOptionsRef.current = options;

  const clearRetryTimer = useCallback(() => {
    if (!retryTimerRef.current) {
      return;
    }

    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const safeSetSnapshot = useCallback(
    (updater: (current: StreamTaskSnapshot) => StreamTaskSnapshot) => {
      if (!mountedRef.current) {
        return;
      }

      setSnapshot(updater);
    },
    [],
  );

  const cleanupHandle = useCallback(() => {
    handleRef.current?.abort();
    handleRef.current = null;
  }, []);

  const open = useCallback(
    (
      starter: StreamStarter,
      lifecycle: StreamTaskLifecycle,
      status: StreamTaskSnapshot["status"],
    ) => {
      clearRetryTimer();
      cleanupHandle();
      lifecycleRef.current = lifecycle;

      safeSetSnapshot((current) => ({
        ...current,
        status,
        error: null,
      }));

      // 本次连接的 handle：onDone 里据此判断"我还是当前连接吗"，
      // 避免旧流的 onDone 迟到时把新流的 handle 清掉（清掉后 abort/cancel 全失效）。
      let selfHandle: StreamTaskHandle | null = null;

      const wrappedLifecycle: StreamTaskLifecycle = {
        ...lifecycle,
        shouldApplyEvent: (event) => {
          const rawId = event.rawId;
          if (!rawId) {
            return true;
          }
          if (
            appliedEventIdRef.current &&
            compareEventId(rawId, appliedEventIdRef.current) <= 0
          ) {
            return false;
          }
          appliedEventIdRef.current = rawId;
          return true;
        },
        onOpen: () => {
          safeSetSnapshot((current) => ({
            ...current,
            status: current.status === "retrying" ? "retrying" : "streaming",
          }));
          lifecycle.onOpen?.();
        },
        onTaskCreated: (task, event) => {
          taskIdRef.current = task.taskId;
          safeSetSnapshot((current) => ({
            ...current,
            task,
          }));
          lifecycle.onTaskCreated?.(task, event);
        },
        onLastEventIdChange: (lastEventId) => {
          lastEventIdRef.current = lastEventId;
          safeSetSnapshot((current) => ({
            ...current,
            lastEventId,
          }));
          lifecycle.onLastEventIdChange?.(lastEventId);
        },
        onCompleted: (event) => {
          safeSetSnapshot((current) => ({
            ...current,
            status: "completed",
          }));
          lifecycle.onCompleted?.(event);
        },
        onCanceled: (event) => {
          safeSetSnapshot((current) => ({
            ...current,
            status: "canceled",
          }));
          lifecycle.onCanceled?.(event);
        },
        onError: (error, event) => {
          if (!event) {
            scheduleRetryRef.current(error);
            return;
          }

          safeSetSnapshot((current) => ({
            ...current,
            status: "error",
            error,
          }));
          lifecycle.onError?.(error, event);
        },
        onDone: () => {
          // 只有仍是当前连接时才清空，防止旧流的 onDone 迟到抹掉新流 handle
          if (selfHandle && handleRef.current === selfHandle) {
            handleRef.current = null;
          }
          lifecycle.onDone?.();
        },
      };

      selfHandle = starter(wrappedLifecycle);
      handleRef.current = selfHandle;
      return selfHandle;
    },
    [cleanupHandle, clearRetryTimer, safeSetSnapshot],
  );

  const resume = useCallback(
    (
      taskId = taskIdRef.current,
      lastEventId = lastEventIdRef.current,
      lifecycle = lifecycleRef.current,
      status: StreamTaskSnapshot["status"] = "retrying",
    ) => {
      if (!taskId) {
        const error = new Error("缺少可恢复的聊天任务 ID");
        safeSetSnapshot((current) => ({
          ...current,
          status: "error",
          error,
        }));
        lifecycle.onError?.(error);
        return null;
      }

      return open(
        (wrappedLifecycle) =>
          streamTaskService.resumeTask(taskId, lastEventId, wrappedLifecycle),
        lifecycle,
        status,
      );
    },
    [open, safeSetSnapshot],
  );

  const submitApproval = useCallback(
    (decision: ApprovalDecision) => {
      const taskId = taskIdRef.current;
      if (!taskId) {
        const error = new Error("缺少可恢复的聊天任务 ID");
        safeSetSnapshot((current) => ({
          ...current,
          status: "error",
          error,
        }));
        lifecycleRef.current.onError?.(error);
        return null;
      }

      return open(
        (wrappedLifecycle) =>
          streamTaskService.submitApproval(
            taskId,
            decision,
            lastEventIdRef.current,
            wrappedLifecycle,
          ),
        lifecycleRef.current,
        "streaming",
      );
    },
    [open, safeSetSnapshot],
  );

  const scheduleRetry = useCallback(
    (fallbackError?: Error) => {
      const taskId = taskIdRef.current;
      if (!taskId) {
        const error =
          fallbackError || new Error("当前任务尚未创建，不能安全重试");
        safeSetSnapshot((current) => ({
          ...current,
          status: "error",
          error,
        }));
        lifecycleRef.current.onError?.(error);
        return false;
      }

      const maxRetries =
        startOptionsRef.current.maxRetries ?? DEFAULT_MAX_RETRIES;
      if (retryCountRef.current >= maxRetries) {
        const error = fallbackError || new Error("重试次数已用完");
        safeSetSnapshot((current) => ({
          ...current,
          status: "error",
          error,
        }));
        lifecycleRef.current.onError?.(error);
        return false;
      }

      retryCountRef.current += 1;
      const retryCount = retryCountRef.current;
      const baseDelay =
        startOptionsRef.current.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
      const delay = baseDelay * 2 ** (retryCount - 1);

      safeSetSnapshot((current) => ({
        ...current,
        status: "retrying",
        retryCount,
      }));

      clearRetryTimer();
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        resume(
          taskId,
          lastEventIdRef.current,
          lifecycleRef.current,
          "retrying",
        );
      }, delay);

      return true;
    },
    [clearRetryTimer, resume, safeSetSnapshot],
  );

  const retry = useCallback(() => {
    scheduleRetry();
  }, [scheduleRetry]);

  scheduleRetryRef.current = scheduleRetry;

  const startChatMessage = useCallback(
    (input: ChatStreamInput, lifecycle: StreamTaskLifecycle = {}) => {
      retryCountRef.current = 0;
      lastEventIdRef.current = "0";
      // 新任务才重置幂等游标（resume/审批续跑必须继承，否则重复帧会被放行）
      appliedEventIdRef.current = "";
      taskIdRef.current = "";

      safeSetSnapshot(() => ({
        status: "connecting",
        task: null,
        error: null,
        retryCount: 0,
        lastEventId: "0",
      }));

      return open(
        (wrappedLifecycle) =>
          streamTaskService.startChatMessage(input, wrappedLifecycle),
        lifecycle,
        "connecting",
      );
    },
    [open, safeSetSnapshot],
  );

  const abort = useCallback(() => {
    clearRetryTimer();
    cleanupHandle();
  }, [cleanupHandle, clearRetryTimer]);

  const cancel = useCallback(async () => {
    const taskId = taskIdRef.current;
    abort();

    safeSetSnapshot((current) => ({
      ...current,
      status: "canceled",
    }));

    if (taskId) {
      await streamTaskService.cancelTask(taskId);
    }
  }, [abort, safeSetSnapshot]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearRetryTimer();
      cleanupHandle();
    };
  }, [cleanupHandle, clearRetryTimer]);

  return {
    ...snapshot,
    startChatMessage,
    resume,
    submitApproval,
    retry,
    cancel,
    abort,
  };
}
