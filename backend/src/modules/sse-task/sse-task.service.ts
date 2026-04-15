import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MessageRole,
  MessageStatus,
  Prisma,
  SseTaskStatus,
  SseTaskType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import type { SseEvent } from '../../common/sse';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AiService } from '../ai/ai.service';
import { ConversationService } from '../conversation/conversation.service';
import { SseTaskRegistry } from './sse-task.registry';

interface ChatTaskPayload {
  content: string;
}

export interface TaskStreamResult {
  stream: AsyncGenerator<SseEvent>;
}

const TERMINAL_EVENTS = new Set([
  'message.done',
  'task.completed',
  'task.error',
  'task.expired',
  'task.canceled',
]);

@Injectable()
export class SseTaskService {
  private readonly logger = new Logger(SseTaskService.name);
  private readonly bufferTtl: number;
  private readonly bufferKeyPrefix: string;
  private readonly lockKeyPrefix = 'sse:lock';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly conversationService: ConversationService,
    private readonly registry: SseTaskRegistry,
  ) {
    this.bufferTtl = this.configService.get<number>('SSE_BUFFER_TTL', 300);
    this.bufferKeyPrefix = 'sse:buffer';
  }

  async createChatTask(
    conversationId: string,
    content: string,
    userId: string,
  ) {
    return this.createTextTask(
      conversationId,
      content,
      userId,
      SseTaskType.CHAT_COMPLETION,
    );
  }

  async createVoiceTask(
    conversationId: string,
    audioBuffer: Buffer,
    filename: string,
    userId: string,
  ) {
    const content = await this.aiService.transcribeAudio(audioBuffer, filename);
    return this.createTextTask(
      conversationId,
      content,
      userId,
      SseTaskType.VOICE_COMPLETION,
    );
  }

  private async createTextTask(
    conversationId: string,
    content: string,
    userId: string,
    type: SseTaskType,
  ) {
    await this.conversationService.ensureOwnership(conversationId, userId);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          role: MessageRole.USER,
          content,
          status: MessageStatus.DONE,
          conversationId,
        },
      });

      const userMessageCount = await tx.message.count({
        where: { conversationId, role: MessageRole.USER },
      });

      if (userMessageCount === 1) {
        await tx.conversation.update({
          where: { id: conversationId },
          data: { title: content.slice(0, 20) },
        });
      }

      const assistantMessage = await tx.message.create({
        data: {
          role: MessageRole.ASSISTANT,
          content: '',
          status: MessageStatus.STREAMING,
          conversationId,
        },
      });

      const task = await tx.sseTask.create({
        data: {
          type,
          status: SseTaskStatus.PENDING,
          userId,
          conversationId,
          messageId: assistantMessage.id,
          requestPayload: { content } satisfies Prisma.JsonObject,
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
        },
      });

      return { task, assistantMessage };
    });

    return {
      taskId: result.task.id,
      messageId: result.assistantMessage.id,
      status: result.task.status.toLowerCase(),
    };
  }

  async getTaskStatus(taskId: string, userId: string) {
    const task = await this.loadTask(taskId, userId);
    return {
      taskId: task.id,
      type: task.type.toLowerCase(),
      status: task.status.toLowerCase(),
      conversationId: task.conversationId,
      messageId: task.messageId,
      lastEventId: task.lastEventId,
      fullContent: task.fullContent,
      errorMessage: task.errorMessage,
      canResume:
        !this.isTerminalStatus(task.status) && task.expiresAt > new Date(),
      expiresAt: task.expiresAt.getTime(),
      updatedAt: task.updatedAt.getTime(),
    };
  }

  async cancelTask(taskId: string, userId: string) {
    const task = await this.loadTask(taskId, userId);

    if (this.isTerminalStatus(task.status)) {
      return { taskId, status: task.status.toLowerCase() };
    }

    const event = await this.persistEvent(
      taskId,
      'task.canceled',
      JSON.stringify({ taskId }),
    );
    await this.prisma.$transaction([
      this.prisma.sseTask.update({
        where: { id: taskId },
        data: {
          status: SseTaskStatus.CANCELED,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
        },
      }),
      this.prisma.message.update({
        where: { id: task.messageId },
        data: { status: MessageStatus.ERROR },
      }),
    ]);

    this.registry.publish(taskId, event);
    return { taskId, status: 'canceled' };
  }

  async resumeTaskStream(
    taskId: string,
    userId: string,
    lastEventId: number,
    signal?: AbortSignal,
  ): Promise<TaskStreamResult> {
    const task = await this.loadTask(taskId, userId);

    if (task.status === SseTaskStatus.EXPIRED || task.expiresAt <= new Date()) {
      await this.expireTask(task.id);
      return {
        stream: this.singleEventStream({
          id: String(lastEventId + 1),
          event: 'task.expired',
          data: JSON.stringify({ taskId }),
        }),
      };
    }

    const stream = this.createTaskStream(task.id, lastEventId, signal);
    return { stream };
  }

  private async *createTaskStream(
    taskId: string,
    lastEventId: number,
    signal?: AbortSignal,
  ): AsyncGenerator<SseEvent> {
    const liveStream = this.registry.subscribe(taskId, signal);
    let lastSeenEventId = lastEventId;

    const replayed = await this.getBufferedEventsAfter(taskId, lastEventId);
    for (const event of replayed) {
      lastSeenEventId = Math.max(lastSeenEventId, Number(event.id));
      yield event;
      if (TERMINAL_EVENTS.has(event.event)) {
        return;
      }
    }

    await this.ensureTaskExecution(taskId);

    for await (const event of liveStream) {
      const numericId = Number(event.id);
      if (Number.isFinite(numericId) && numericId <= lastSeenEventId) {
        continue;
      }

      lastSeenEventId = Math.max(lastSeenEventId, numericId);
      yield event;

      if (TERMINAL_EVENTS.has(event.event)) {
        return;
      }
    }
  }

  private async ensureTaskExecution(taskId: string) {
    if (this.registry.isRunning(taskId)) {
      return;
    }

    const lockValue = randomUUID();
    const lockKey = `${this.lockKeyPrefix}:${taskId}`;
    const acquired = await this.redis.set(lockKey, lockValue, 'EX', 300, 'NX');
    if (acquired !== 'OK') {
      return;
    }

    this.registry.markRunning(taskId);

    void this.runTask(taskId, lockKey, lockValue).finally(() => {
      this.registry.clearRunning(taskId);
    });
  }

  private async runTask(taskId: string, lockKey: string, lockValue: string) {
    try {
      const task = await this.prisma.sseTask.findUnique({
        where: { id: taskId },
      });

      if (!task || this.isTerminalStatus(task.status)) {
        return;
      }

      await this.prisma.sseTask.update({
        where: { id: taskId },
        data: {
          status: SseTaskStatus.STREAMING,
          startedAt: task.startedAt ?? new Date(),
        },
      });

      const startedEvent = await this.persistEvent(
        taskId,
        'task.started',
        JSON.stringify({ taskId, messageId: task.messageId }),
      );
      this.registry.publish(taskId, startedEvent);

      if (task.type === SseTaskType.CHAT_COMPLETION) {
        await this.runChatTask(task);
      }
    } catch (error) {
      this.logger.error(`SSE task failed: ${(error as Error).message}`);
      await this.failTask(taskId, (error as Error).message);
    } finally {
      await this.releaseLock(lockKey, lockValue);
    }
  }

  private async runChatTask(task: {
    id: string;
    conversationId: string;
    messageId: string;
    requestPayload: Prisma.JsonValue;
  }) {
    const payload = task.requestPayload as unknown as ChatTaskPayload;
    const history = await this.prisma.message.findMany({
      where: { conversationId: task.conversationId },
      orderBy: { createdAt: 'asc' },
    });

    const messages = history
      .filter((message) => message.id !== task.messageId)
      .map((message) => ({
        role:
          message.role === MessageRole.USER
            ? ('user' as const)
            : ('assistant' as const),
        content: message.content,
      }));

    if (!payload.content) {
      throw new Error('Missing chat task payload');
    }

    let fullContent = '';

    for await (const chunk of this.aiService.streamChat(messages)) {
      fullContent += chunk;
      const deltaEvent = await this.persistEvent(
        task.id,
        'message.delta',
        JSON.stringify({
          taskId: task.id,
          messageId: task.messageId,
          delta: chunk,
        }),
        {
          fullContent,
          status: SseTaskStatus.STREAMING,
        },
      );
      this.registry.publish(task.id, deltaEvent);
    }

    const doneEvent = await this.persistEvent(
      task.id,
      'message.done',
      JSON.stringify({
        taskId: task.id,
        messageId: task.messageId,
        content: fullContent,
      }),
      {
        fullContent,
        status: SseTaskStatus.COMPLETED,
      },
    );

    await this.prisma.$transaction([
      this.prisma.message.update({
        where: { id: task.messageId },
        data: {
          content: fullContent,
          status: MessageStatus.DONE,
        },
      }),
      this.prisma.conversation.update({
        where: { id: task.conversationId },
        data: { updatedAt: new Date() },
      }),
      this.prisma.sseTask.update({
        where: { id: task.id },
        data: {
          status: SseTaskStatus.COMPLETED,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
          fullContent,
        },
      }),
    ]);

    this.registry.publish(task.id, doneEvent);

    const completedEvent = await this.persistEvent(
      task.id,
      'task.completed',
      JSON.stringify({ taskId: task.id, messageId: task.messageId }),
      {
        fullContent,
        status: SseTaskStatus.COMPLETED,
      },
    );
    this.registry.publish(task.id, completedEvent);
  }

  private async failTask(taskId: string, message: string) {
    const task = await this.prisma.sseTask.findUnique({
      where: { id: taskId },
    });
    if (!task) {
      return;
    }

    const errorEvent = await this.persistEvent(
      taskId,
      'task.error',
      JSON.stringify({ taskId, message }),
      {
        status: SseTaskStatus.ERROR,
        errorMessage: message,
        fullContent: task.fullContent,
      },
    );

    await this.prisma.$transaction([
      this.prisma.sseTask.update({
        where: { id: taskId },
        data: {
          status: SseTaskStatus.ERROR,
          errorMessage: message,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
        },
      }),
      this.prisma.message.update({
        where: { id: task.messageId },
        data: {
          content: task.fullContent || '生成失败',
          status: MessageStatus.ERROR,
        },
      }),
    ]);

    this.registry.publish(taskId, errorEvent);
  }

  private async persistEvent(
    taskId: string,
    event: string,
    data: string,
    taskUpdate?: Partial<{
      status: SseTaskStatus;
      errorMessage: string | null;
      fullContent: string;
    }>,
  ) {
    const task = await this.prisma.sseTask.update({
      where: { id: taskId },
      data: {
        lastEventId: { increment: 1 },
        lastHeartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
        ...taskUpdate,
      },
      select: {
        lastEventId: true,
      },
    });

    const sseEvent: SseEvent = {
      id: String(task.lastEventId),
      event,
      data,
    };

    await this.redis.zadd(
      this.bufferKey(taskId),
      Number(sseEvent.id),
      JSON.stringify(sseEvent),
    );
    await this.redis.expire(this.bufferKey(taskId), this.bufferTtl);

    return sseEvent;
  }

  private async getBufferedEventsAfter(taskId: string, lastEventId: number) {
    const rawEvents = await this.redis.zrangebyscore(
      this.bufferKey(taskId),
      lastEventId + 1,
      '+inf',
    );

    const events: SseEvent[] = [];
    for (const raw of rawEvents) {
      try {
        events.push(JSON.parse(raw) as SseEvent);
      } catch {
        continue;
      }
    }
    return events;
  }

  private async expireTask(taskId: string) {
    await this.prisma.sseTask.update({
      where: { id: taskId },
      data: { status: SseTaskStatus.EXPIRED },
    });
  }

  private async loadTask(taskId: string, userId: string) {
    const task = await this.prisma.sseTask.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new NotFoundException('SSE 任务不存在');
    }

    if (task.userId !== userId) {
      throw new ForbiddenException('无权访问该 SSE 任务');
    }

    return task;
  }

  private isTerminalStatus(status: SseTaskStatus) {
    return (
      status === SseTaskStatus.COMPLETED ||
      status === SseTaskStatus.ERROR ||
      status === SseTaskStatus.EXPIRED ||
      status === SseTaskStatus.CANCELED
    );
  }

  private async releaseLock(lockKey: string, lockValue: string) {
    const currentValue = await this.redis.get(lockKey);
    if (currentValue === lockValue) {
      await this.redis.del(lockKey);
    }
  }

  private bufferKey(taskId: string) {
    return `${this.bufferKeyPrefix}:${taskId}`;
  }

  private singleEventStream(event: SseEvent): AsyncGenerator<SseEvent> {
    return (async function* () {
      await Promise.resolve();
      yield event;
    })();
  }
}
