import { Injectable } from '@nestjs/common';
import type { SseEvent } from '../../common/sse';

class TaskChannel {
  private readonly listeners = new Set<(event: SseEvent) => void>();

  emit(event: SseEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(signal?: AbortSignal): AsyncGenerator<SseEvent> {
    const queue: SseEvent[] = [];
    const listeners = this.listeners;
    let wake: (() => void) | undefined;
    let closed = false;

    const listener = (event: SseEvent) => {
      queue.push(event);
      wake?.();
      wake = undefined;
    };

    const abort = () => {
      closed = true;
      wake?.();
      wake = undefined;
    };

    this.listeners.add(listener);
    signal?.addEventListener('abort', abort, { once: true });

    return (async function* () {
      try {
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }

          while (queue.length > 0) {
            const event = queue.shift();
            if (event) {
              yield event;
            }
          }
        }
      } finally {
        listeners.delete(listener);
        signal?.removeEventListener('abort', abort);
      }
    })();
  }

  get listenerCount() {
    return this.listeners.size;
  }
}

@Injectable()
export class StreamTaskRegistry {
  private readonly channels = new Map<string, TaskChannel>();
  private readonly runningTasks = new Map<string, AbortController>();

  getOrCreateChannel(taskId: string) {
    const existing = this.channels.get(taskId);
    if (existing) {
      return existing;
    }

    const channel = new TaskChannel();
    this.channels.set(taskId, channel);
    return channel;
  }

  subscribe(taskId: string, signal?: AbortSignal) {
    return this.getOrCreateChannel(taskId).subscribe(signal);
  }

  publish(taskId: string, event: SseEvent) {
    this.getOrCreateChannel(taskId).emit(event);
  }

  /**
   * 注册任务执行控制器
   * @param taskId 任务ID
   * @param abortController 任务执行中使用的 AbortController
   * @returns 无返回值
   * @description 在任务开始执行前注册对应的 AbortController，供取消任务时中断上游生成调用。
   */
  markRunning(taskId: string, abortController: AbortController) {
    this.runningTasks.set(taskId, abortController);
  }

  /**
   * 中断正在执行的任务
   * @param taskId 任务ID
   * @param reason 中断原因
   * @returns 返回布尔值，true 表示已触发中断，false 表示当前没有运行中的任务
   * @description 如果任务当前处于执行中，则触发其 AbortController，使上游模型调用尽快终止。
   */
  abortRunning(taskId: string, reason?: unknown) {
    const abortController = this.runningTasks.get(taskId);
    if (!abortController) {
      return false;
    }

    abortController.abort(reason);
    return true;
  }

  clearRunning(taskId: string) {
    this.runningTasks.delete(taskId);
    const channel = this.channels.get(taskId);
    if (channel && channel.listenerCount === 0) {
      this.channels.delete(taskId);
    }
  }

  isRunning(taskId: string) {
    return this.runningTasks.has(taskId);
  }
}
