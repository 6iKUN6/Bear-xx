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
import { LlmService } from '../llm/llm.service';
import type { LlmTextRequest, ResolvedLlmTextRequest } from '../llm/llm.types';
import { ConversationService } from '../conversation/conversation.service';
import { SseTaskRegistry } from './sse-task.registry';

interface ChatTaskPayload {
  content: string;
  llm?: ResolvedLlmTextRequest;
}

export interface TaskStreamResult {
  stream: AsyncGenerator<SseEvent>;
}

const TASK_CANCELED_REASON = 'task_canceled';

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
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
    private readonly conversationService: ConversationService,
    private readonly registry: SseTaskRegistry,
  ) {
    this.bufferTtl = this.configService.get<number>('SSE_BUFFER_TTL', 300);
    this.bufferKeyPrefix = 'sse:buffer';
  }

  /**
   * 创建文本聊天任务
   * @param conversationId 会话ID
   * @param content 用户消息内容
   * @param userId 用户ID
   * @param llmRequest 文本生成请求配置
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 基于文本消息创建一条可恢复的 SSE 聊天任务，并将本次请求的模型选择配置持久化到任务中。
   */
  async createChatTask(
    conversationId: string,
    content: string,
    userId: string,
    llmRequest?: LlmTextRequest,
  ) {
    return this.createTextTask(
      conversationId,
      content,
      userId,
      SseTaskType.CHAT_COMPLETION,
      llmRequest,
    );
  }

  /**
   * 创建语音聊天任务
   * @param conversationId 会话ID
   * @param audioBuffer 音频二进制数据
   * @param filename 音频文件名
   * @param userId 用户ID
   * @param llmRequest 文本生成请求配置
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 先将音频转写成文本，再复用文本任务创建逻辑生成可恢复的 SSE 任务，并保留模型配置。
   */
  async createVoiceTask(
    conversationId: string,
    audioBuffer: Buffer,
    filename: string,
    userId: string,
    llmRequest?: LlmTextRequest,
  ) {
    const content = await this.aiService.transcribeAudio(audioBuffer, filename);
    return this.createTextTask(
      conversationId,
      content,
      userId,
      SseTaskType.VOICE_COMPLETION,
      llmRequest,
    );
  }

  /**
   * 创建文本类型的 SSE 任务
   * @param conversationId 会话ID
   * @param content 消息内容
   * @param userId 用户ID
   * @param type 任务类型
   * @param llmRequest 文本生成请求配置
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 在一个事务内依次写入用户消息、assistant 占位消息以及 SSE 任务记录，并将解析后的模型配置一并持久化。
   */
  private async createTextTask(
    conversationId: string,
    content: string,
    userId: string,
    type: SseTaskType,
    llmRequest?: LlmTextRequest,
  ) {
    await this.conversationService.ensureOwnership(conversationId, userId);
    const resolvedLlmRequest = this.llmService.resolveTextRequest(llmRequest);
    const requestPayload = JSON.parse(
      JSON.stringify({
        content,
        llm: resolvedLlmRequest,
      }),
    ) as Prisma.JsonObject;

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
          requestPayload,
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

  /**
   * 查询任务状态
   * @param taskId 任务ID
   * @param userId 用户ID
   * @returns 返回任务详情信息，包括状态、会话ID、最后事件ID、累计内容和过期时间等
   * @description 加载指定 SSE 任务，并返回前端恢复流或展示状态所需的全部关键信息。
   */
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

  /**
   * 取消任务
   * @param taskId 任务ID
   * @param userId 用户ID
   * @returns 返回任务取消结果，包含 taskId 和最新状态
   * @description 对未进入终态的任务发送取消事件并更新任务、消息状态；若任务已结束，则直接返回当前状态。
   */
  async cancelTask(taskId: string, userId: string) {
    const task = await this.loadTask(taskId, userId);

    if (this.isTerminalStatus(task.status)) {
      return { taskId, status: task.status.toLowerCase() };
    }

    const event = await this.persistEvent(
      taskId,
      'task.canceled',
      JSON.stringify({ taskId, messageId: task.messageId }),
      {
        status: SseTaskStatus.CANCELED,
        fullContent: task.fullContent,
      },
    );
    const abortedRunningTask = this.registry.abortRunning(
      taskId,
      TASK_CANCELED_REASON,
    );

    if (abortedRunningTask) {
      this.logger.debug(`Abort running provider stream for task ${taskId}`);
    }

    await this.prisma.$transaction([
      this.prisma.sseTask.update({
        where: { id: taskId },
        data: {
          status: SseTaskStatus.CANCELED,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
          fullContent: task.fullContent,
        },
      }),
      this.prisma.message.update({
        where: { id: task.messageId },
        data: {
          content: task.fullContent || '生成已取消',
          status: MessageStatus.ERROR,
        },
      }),
    ]);

    this.registry.publish(taskId, event);
    return { taskId, status: 'canceled' };
  }

  /**
   * 恢复任务流
   * @param taskId 任务ID
   * @param userId 用户ID
   * @param lastEventId 客户端已接收的最后事件ID
   * @param signal 连接中断信号
   * @returns 返回包含异步 SSE 事件流的对象
   * @description 校验任务状态并根据游标恢复事件流；若任务已过期，则返回单个过期事件流。
   */
  async resumeTaskStream(
    taskId: string,
    userId: string,
    lastEventId: number,
    signal?: AbortSignal,
  ): Promise<TaskStreamResult> {
    const task = await this.loadTask(taskId, userId);

    //任务过期
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

  /**
   * 创建任务事件流
   * @param taskId 任务ID
   * @param lastEventId 客户端已接收的最后事件ID
   * @param signal 连接中断信号
   * @returns 返回可迭代的 SSE 事件流
   * @description 先重放 Redis 缓冲中的历史事件，再订阅内存中的实时事件，并按需触发任务执行。
   */
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

  /**
   * 确保任务开始执行
   * @param taskId 任务ID
   * @returns 无返回值
   * @description 通过内存标记和 Redis 分布式锁保证同一个任务在同一时刻只会被一个生产者执行。
   */
  private async ensureTaskExecution(taskId: string) {
    if (this.registry.isRunning(taskId)) {
      return;
    }

    const executionAbortController = new AbortController();
    const lockValue = randomUUID();
    const lockKey = `${this.lockKeyPrefix}:${taskId}`;
    const acquired = await this.redis.set(lockKey, lockValue, 'EX', 300, 'NX');
    if (acquired !== 'OK') {
      return;
    }

    this.registry.markRunning(taskId, executionAbortController);

    void this.runTask(
      taskId,
      lockKey,
      lockValue,
      executionAbortController.signal,
    ).finally(() => {
      this.registry.clearRunning(taskId);
    });
  }

  /**
   * 执行任务主体
   * @param taskId 任务ID
   * @param lockKey Redis 锁 Key
   * @param lockValue Redis 锁值
   * @param executionSignal 执行中断信号
   * @returns 无返回值
   * @description 加载任务、更新状态为执行中，发布 started 事件，并根据任务类型分派到实际执行逻辑。
   */
  private async runTask(
    taskId: string,
    lockKey: string,
    lockValue: string,
    executionSignal: AbortSignal,
  ) {
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
        await this.runChatTask(task, executionSignal);
      }
    } catch (error) {
      if (await this.shouldIgnoreAbort(taskId, error, executionSignal)) {
        return;
      }

      this.logger.error(`SSE task failed: ${(error as Error).message}`);
      await this.failTask(taskId, (error as Error).message);
    } finally {
      await this.releaseLock(lockKey, lockValue);
    }
  }

  /**
   * 执行聊天任务
   * @param task 聊天任务上下文
   * @param executionSignal 执行中断信号
   * @returns 无返回值
   * @description 读取会话历史并调用大模型流式生成回复，将增量内容、完成事件和最终内容持续写入任务状态与事件流。
   */
  private async runChatTask(
    task: {
      id: string;
      conversationId: string;
      messageId: string;
      requestPayload: Prisma.JsonValue;
    },
    executionSignal: AbortSignal,
  ) {
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

    for await (const chunk of this.llmService.streamChatText(
      messages,
      payload.llm,
      {
        abortSignal: executionSignal,
      },
    )) {
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

    if (executionSignal.aborted) {
      throw executionSignal.reason;
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

  /**
   * 标记任务失败
   * @param taskId 任务ID
   * @param message 错误信息
   * @returns 无返回值
   * @description 将任务和对应消息更新为失败状态，同时写入并发布 task.error 事件。
   */
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

  /**
   * 持久化任务事件
   * @param taskId 任务ID
   * @param event 事件名
   * @param data 事件数据
   * @param taskUpdate 任务字段更新内容
   * @returns 返回包含稳定事件ID的 SSE 事件对象
   * @description 为任务分配递增事件ID，更新任务游标和内容快照，并把事件写入 Redis 缓冲区供恢复重放。
   */
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

  /**
   * 读取缓冲区事件
   * @param taskId 任务ID
   * @param lastEventId 客户端已接收的最后事件ID
   * @returns 返回指定游标之后的 SSE 事件列表
   * @description 从 Redis 缓冲区中读取任务未消费的历史事件，用于断线后的补发与重放。
   */
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

  /**
   * 标记任务过期
   * @param taskId 任务ID
   * @returns 无返回值
   * @description 将指定任务更新为 EXPIRED 状态，表示其恢复窗口已失效。
   */
  private async expireTask(taskId: string) {
    await this.prisma.sseTask.update({
      where: { id: taskId },
      data: { status: SseTaskStatus.EXPIRED },
    });
  }

  /**
   * 加载并校验任务
   * @param taskId 任务ID
   * @param userId 用户ID
   * @returns 返回已加载且权限校验通过的任务记录
   * @description 查询指定任务并校验其归属；若任务不存在或不属于当前用户，则抛出异常。
   */
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

  /**
   * 判断任务是否为终态
   * @param status 任务状态
   * @returns 返回布尔值，true 表示任务已结束
   * @description 用于统一判断任务是否已经进入 completed、error、expired 或 canceled 等终止状态。
   */
  private isTerminalStatus(status: SseTaskStatus) {
    return (
      status === SseTaskStatus.COMPLETED ||
      status === SseTaskStatus.ERROR ||
      status === SseTaskStatus.EXPIRED ||
      status === SseTaskStatus.CANCELED
    );
  }

  /**
   * 判断是否应忽略中断错误
   * @param taskId 任务ID
   * @param error 执行异常
   * @param executionSignal 执行中断信号
   * @returns 返回布尔值，true 表示该异常属于已处理的中断场景
   * @description 在任务被主动取消后，上游 provider 可能抛出中断异常；此时不应再将任务写入失败状态。
   */
  private async shouldIgnoreAbort(
    taskId: string,
    error: unknown,
    executionSignal: AbortSignal,
  ) {
    if (
      !executionSignal.aborted &&
      !this.isAbortError(error) &&
      error !== TASK_CANCELED_REASON
    ) {
      return false;
    }

    const task = await this.prisma.sseTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    });

    return task?.status === SseTaskStatus.CANCELED;
  }

  /**
   * 判断异常是否为中断错误
   * @param error 执行异常
   * @returns 返回布尔值，true 表示该异常属于 AbortError
   * @description 用于识别 provider 在接收到 AbortSignal 后抛出的标准中断异常。
   */
  private isAbortError(error: unknown) {
    return (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        error.message.toLowerCase().includes('aborted'))
    );
  }

  /**
   * 释放任务执行锁
   * @param lockKey Redis 锁 Key
   * @param lockValue Redis 锁值
   * @returns 无返回值
   * @description 仅当当前实例仍持有该锁时才删除 Redis 锁，避免误删其他执行者的锁。
   */
  private async releaseLock(lockKey: string, lockValue: string) {
    const currentValue = await this.redis.get(lockKey);
    if (currentValue === lockValue) {
      await this.redis.del(lockKey);
    }
  }

  /**
   * 生成任务缓冲区 Key
   * @param taskId 任务ID
   * @returns 返回任务事件缓冲区对应的 Redis Key
   * @description 按统一命名规则生成指定任务的 Redis 缓冲区 Key。
   */
  private bufferKey(taskId: string) {
    return `${this.bufferKeyPrefix}:${taskId}`;
  }

  /**
   * 包装单事件异步流
   * @param event SSE 事件对象
   * @returns 返回只会产出单个事件的异步流
   * @description 用于过期等场景，将单个事件包装成符合 SSE 输出约定的异步迭代器。
   */
  private singleEventStream(event: SseEvent): AsyncGenerator<SseEvent> {
    return (async function* () {
      await Promise.resolve();
      yield event;
    })();
  }
}
