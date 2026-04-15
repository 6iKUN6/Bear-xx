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
export class SseTaskRegistry {
  private readonly channels = new Map<string, TaskChannel>();
  private readonly runningTasks = new Set<string>();

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

  markRunning(taskId: string) {
    this.runningTasks.add(taskId);
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
