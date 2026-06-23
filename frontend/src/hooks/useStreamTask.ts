import { useCallback, useEffect, useRef, useState } from "react";
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

type StreamStarter = (
  lifecycle: StreamTaskLifecycle,
) => StreamTaskHandle;

const initialSnapshot: StreamTaskSnapshot = {
  status: "idle",
  task: null,
  error: null,
  retryCount: 0,
  lastEventId: 0,
};

export function useStreamTask(options: StreamTaskStartOptions = {}) {
  const [snapshot, setSnapshot] =
    useState<StreamTaskSnapshot>(initialSnapshot);
  const handleRef = useRef<StreamTaskHandle | null>(null);
  const taskIdRef = useRef<string>("");
  const lastEventIdRef = useRef(0);
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

      const wrappedLifecycle: StreamTaskLifecycle = {
        ...lifecycle,
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
          handleRef.current = null;
          lifecycle.onDone?.();
        },
      };

      handleRef.current = starter(wrappedLifecycle);
      return handleRef.current;
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
        resume(taskId, lastEventIdRef.current, lifecycleRef.current, "retrying");
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
      lastEventIdRef.current = 0;
      taskIdRef.current = "";

      safeSetSnapshot(() => ({
        status: "connecting",
        task: null,
        error: null,
        retryCount: 0,
        lastEventId: 0,
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
    retry,
    cancel,
    abort,
  };
}
