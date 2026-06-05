import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  StreamTaskStatus,
  StreamTaskRunStatus,
  StreamTaskType,
  MessageRole,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import type { SseEvent } from '../../common/sse';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AiService } from '../ai/ai.service';
import {
  CommonChatAgentRunnerService,
  type CommonChatAgentStreamEvent,
} from '../ai/agents';
import type { LlmTextRequest, ResolvedLlmTextRequest } from '../llm/llm.types';
import { ConversationService } from '../conversation/conversation.service';
import { ConversationSummaryService } from '../memory/conversation-summary.service';
import { StreamTaskRegistry } from './stream-task.registry';

interface ChatTaskPayload {
  content: string;
  llm?: ResolvedLlmTextRequest;
}

interface CreatedTaskResult {
  taskId: string;
  streamId: string;
  messageId: string;
  conversationId: string;
  status: string;
}

interface StreamTaskEventData<TPayload = undefined> {
  type: string;
  taskId: string;
  streamId?: string;
  conversationId: string;
  messageId: string;
  status: string;
  payload?: TPayload;
  errorMessage?: string;
}

export interface TaskStreamResult {
  stream: AsyncGenerator<SseEvent>;
}

const TASK_CANCELED_REASON = 'task_canceled';
const EMPTY_ASSISTANT_CONTENT =
  '模型本次没有返回有效文本。请检查模型名称、中转站响应格式或流式输出配置。';

const TERMINAL_EVENTS = new Set([
  'task.completed',
  'task.error',
  'task.expired',
  'task.canceled',
]);

const INITIAL_STREAM_TRIGGER = 'initial';

@Injectable()
export class StreamTaskService {
  private readonly logger = new Logger(StreamTaskService.name);
  private readonly bufferTtl: number;
  private readonly bufferKeyPrefix: string;
  private readonly lockKeyPrefix = 'stream-task:lock';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly aiService: AiService,
    private readonly commonChatAgentRunnerService: CommonChatAgentRunnerService,
    private readonly configService: ConfigService,
    private readonly conversationService: ConversationService,
    private readonly conversationSummaryService: ConversationSummaryService,
    private readonly registry: StreamTaskRegistry,
  ) {
    this.bufferTtl =
      this.configService.get<number>('STREAM_TASK_BUFFER_TTL') ??
      this.configService.get<number>('SSE_BUFFER_TTL', 300);
    this.bufferKeyPrefix = 'stream-task:buffer';
  }

  /**
   * 创建文本聊天任务
   * @param conversationId 会话ID
   * @param content 用户消息内容
   * @param userId 用户ID
   * @param llmRequest 文本生成请求配置
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 基于文本消息创建一条可恢复的流式聊天任务，并将本次请求的模型选择配置持久化到任务中。
   */
  async createChatTask(
    conversationId: string | undefined,
    content: string,
    userId: string,
    llmRequest?: LlmTextRequest,
  ) {
    return this.createTextTask(
      conversationId,
      content,
      userId,
      StreamTaskType.CHAT_COMPLETION,
      llmRequest,
    );
  }

  /**
   * 创建文本任务并直接返回首轮流式结果
   * @param conversationId 会话ID
   * @param content 用户消息内容
   * @param userId 用户ID
   * @param llmRequest 文本生成请求配置
   * @param signal 连接中断信号
   * @returns 返回包含异步流式事件的对象
   * @description 用于聊天主入口：先创建可恢复任务，再在同一请求中直接进入首轮流式事件，同时向客户端下发 task.created 事件。
   */
  async streamChatTask(
    conversationId: string | undefined,
    content: string,
    userId: string,
    llmRequest?: LlmTextRequest,
    signal?: AbortSignal,
  ): Promise<TaskStreamResult> {
    const task = await this.createChatTask(
      conversationId,
      content,
      userId,
      llmRequest,
    );
    const taskStream = await this.openTaskStream(
      task.taskId,
      userId,
      0,
      signal,
    );

    return {
      stream: this.prependEvent(
        this.buildTaskSseEvent('0', 'task.created', {
          taskId: task.taskId,
          streamId: task.streamId,
          conversationId: task.conversationId,
          messageId: task.messageId,
          status: task.status,
        }),
        taskStream.stream,
      ),
    };
  }

  /**
   * 创建语音聊天任务
   * @param conversationId 会话ID
   * @param audioBuffer 音频二进制数据
   * @param filename 音频文件名
   * @param userId 用户ID
   * @param llmRequest 文本生成请求配置
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 先将音频转写成文本，再复用文本任务创建逻辑生成可恢复的流式任务，并保留模型配置。
   */
  async createVoiceTask(
    conversationId: string | undefined,
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
      StreamTaskType.VOICE_COMPLETION,
      llmRequest,
    );
  }

  /**
   * 创建文本类型的 流式任务
   * @param conversationId 会话ID
   * @param content 消息内容
   * @param userId 用户ID
   * @param type 任务类型
   * @param llmRequest 文本生成请求配置
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 在一个事务内依次写入用户消息、assistant 占位消息以及 流式任务记录，并将解析后的模型配置一并持久化。
   */
  private async createTextTask(
    conversationId: string | undefined,
    content: string,
    userId: string,
    type: StreamTaskType,
    llmRequest?: LlmTextRequest,
  ) {
    const resolvedLlmRequest =
      this.commonChatAgentRunnerService.resolveTextRequest(llmRequest);
    const requestPayload = JSON.parse(
      JSON.stringify({
        content,
        llm: resolvedLlmRequest,
      }),
    ) as Prisma.JsonObject;

    const result = await this.prisma.$transaction(async (tx) => {
      const targetConversationId = await this.resolveConversationId(
        tx,
        conversationId,
        userId,
      );

      //消息入库
      await tx.message.create({
        data: {
          role: MessageRole.USER,
          content,
          status: MessageStatus.DONE,
          conversationId: targetConversationId,
        },
      });

      //统计用户消息数量
      const userMessageCount = await tx.message.count({
        where: { conversationId: targetConversationId, role: MessageRole.USER },
      });

      if (userMessageCount === 1) {
        await tx.conversation.update({
          where: { id: targetConversationId },
          data: { title: content.slice(0, 20) },
        });
      }

      //assistant 消息入库
      const assistantMessage = await tx.message.create({
        data: {
          role: MessageRole.ASSISTANT,
          content: '',
          status: MessageStatus.STREAMING,
          conversationId: targetConversationId,
        },
      });

      //流式任务入库
      const task = await tx.streamTask.create({
        data: {
          type,
          status: StreamTaskStatus.PENDING,
          userId,
          conversationId: targetConversationId,
          messageId: assistantMessage.id,
          requestPayload,
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
        },
      });

      const stream = await tx.streamTaskRun.create({
        data: {
          taskId: task.id,
          sequence: 1,
          status: StreamTaskRunStatus.PENDING,
          trigger: INITIAL_STREAM_TRIGGER,
        },
      });

      await tx.streamTask.update({
        where: { id: task.id },
        data: { currentRunId: stream.id },
      });

      return {
        task,
        stream,
        assistantMessage,
        conversationId: targetConversationId,
      };
    });

    return {
      taskId: result.task.id,
      streamId: result.stream.id,
      messageId: result.assistantMessage.id,
      conversationId: result.conversationId,
      status: result.task.status.toLowerCase(),
    } satisfies CreatedTaskResult;
  }

  /**
   * 解析会话ID
   * @param tx Prisma 事务客户端
   * @param conversationId 会话ID
   * @param userId 用户ID
   * @returns 返回可用于本次任务的会话ID
   * @description 当请求未传会话ID时自动创建新会话；若已传，则在事务内校验该会话属于当前用户，保证首轮消息和会话创建在同一链路中闭环。
   */
  private async resolveConversationId(
    tx: Prisma.TransactionClient,
    conversationId: string | undefined,
    userId: string,
  ): Promise<string> {
    if (!conversationId) {
      const conversation = await tx.conversation.create({
        data: {
          userId,
          title: '新对话',
        },
      });

      return conversation.id;
    }

    const conversation = await tx.conversation.findFirst({
      where: {
        id: conversationId,
        userId,
      },
      select: {
        id: true,
      },
    });

    if (!conversation) {
      throw new NotFoundException('会话不存在');
    }

    return conversation.id;
  }

  /**
   * 查询任务状态
   * @param taskId 任务ID
   * @param userId 用户ID
   * @returns 返回任务详情信息，包括状态、会话ID、最后事件ID、累计内容和过期时间等
   * @description 加载指定 流式任务，并返回前端恢复流或展示状态所需的全部关键信息。
   */
  async getTaskStatus(taskId: string, userId: string) {
    const task = await this.loadTask(taskId, userId);
    return {
      taskId: task.id,
      streamId: task.currentRunId,
      type: task.type.toLowerCase(),
      status: task.status.toLowerCase(),
      conversationId: this.requireConversationId(task),
      messageId: this.requireMessageId(task),
      lastEventId: task.lastEventId,
      fullContent: task.fullContent,
      errorMessage: task.errorMessage,
      canResume:
        !this.isTerminalStatus(task.status) &&
        (!task.expiresAt || task.expiresAt > new Date()),
      expiresAt: task.expiresAt?.getTime() ?? null,
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

    const conversationId = this.requireConversationId(task);
    const messageId = this.requireMessageId(task);
    const event = await this.persistEvent(
      taskId,
      task.currentRunId,
      'task.canceled',
      this.serializeTaskEventData({
        type: 'task.canceled',
        taskId,
        streamId: task.currentRunId ?? undefined,
        conversationId,
        messageId,
        status: StreamTaskStatus.CANCELED.toLowerCase(),
      }),
      {
        status: StreamTaskStatus.CANCELED,
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
      this.prisma.streamTask.update({
        where: { id: taskId },
        data: {
          status: StreamTaskStatus.CANCELED,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
          fullContent: task.fullContent,
        },
      }),
      ...(task.currentRunId
        ? [
            this.prisma.streamTaskRun.update({
              where: { id: task.currentRunId },
              data: {
                status: StreamTaskRunStatus.CANCELED,
                endedAt: new Date(),
                closeReason: 'task_canceled',
                endEventId: task.lastEventId + 1,
              },
            }),
          ]
        : []),
      this.prisma.message.update({
        where: { id: messageId },
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
   * @returns 返回包含异步流式事件的对象
   * @description 校验任务状态并根据游标恢复事件流；若任务已过期，则返回单个过期事件流。
   */
  async openTaskStream(
    taskId: string,
    userId: string,
    lastEventId: number,
    signal?: AbortSignal,
  ): Promise<TaskStreamResult> {
    const task = await this.loadTask(taskId, userId);

    //任务过期
    if (
      task.status === StreamTaskStatus.EXPIRED ||
      (task.expiresAt && task.expiresAt <= new Date())
    ) {
      await this.expireTask(task.id);
      return {
        stream: this.singleEventStream(
          this.buildTaskSseEvent(String(lastEventId + 1), 'task.expired', {
            taskId,
            streamId: task.currentRunId ?? undefined,
            conversationId: this.requireConversationId(task),
            messageId: this.requireMessageId(task),
            status: StreamTaskStatus.EXPIRED.toLowerCase(),
          }),
        ),
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
   * @returns 返回可迭代的流式事件
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
      const task = await this.prisma.streamTask.findUnique({
        where: { id: taskId },
      });

      if (!task || this.isTerminalStatus(task.status)) {
        return;
      }

      const stream = await this.ensureCurrentStream(task.id);

      await this.prisma.$transaction([
        this.prisma.streamTask.update({
          where: { id: taskId },
          data: {
            status: StreamTaskStatus.STREAMING,
            startedAt: task.startedAt ?? new Date(),
            currentRunId: stream.id,
            currentAgent: 'common-chat-agent',
            currentStep: 'streaming',
          },
        }),
        this.prisma.streamTaskRun.update({
          where: { id: stream.id },
          data: {
            status: StreamTaskRunStatus.STREAMING,
            startedAt: stream.startedAt ?? new Date(),
          },
        }),
      ]);

      const conversationId = this.requireConversationId(task);
      const messageId = this.requireMessageId(task);

      const startedEvent = await this.persistEvent(
        taskId,
        stream.id,
        'task.started',
        this.serializeTaskEventData({
          type: 'task.started',
          taskId,
          streamId: stream.id,
          conversationId,
          messageId,
          status: StreamTaskStatus.STREAMING.toLowerCase(),
        }),
      );
      this.registry.publish(taskId, startedEvent);

      if (
        task.type === StreamTaskType.CHAT_COMPLETION ||
        task.type === StreamTaskType.VOICE_COMPLETION
      ) {
        await this.runChatTask(
          {
            id: task.id,
            streamId: stream.id,
            conversationId,
            messageId,
            requestPayload: task.requestPayload,
          },
          executionSignal,
        );
      }
    } catch (error) {
      if (await this.shouldIgnoreAbort(taskId, error, executionSignal)) {
        return;
      }

      this.logger.error(`Stream task failed: ${(error as Error).message}`);
      await this.failTask(taskId, (error as Error).message);
    } finally {
      await this.releaseLock(lockKey, lockValue);
    }
  }

  /**
   * 确保任务存在当前执行流片段
   * @param taskId 任务ID
   * @returns 返回当前任务流片段
   * @description 当前单 agent 任务默认只创建一个流片段；后续人机协同时可在 continue 阶段创建新的流片段。
   */
  private async ensureCurrentStream(taskId: string) {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
      select: { currentRunId: true },
    });

    if (task?.currentRunId) {
      const stream = await this.prisma.streamTaskRun.findUnique({
        where: { id: task.currentRunId },
      });

      if (stream) {
        return stream;
      }
    }

    const latestStream = await this.prisma.streamTaskRun.findFirst({
      where: { taskId },
      orderBy: { sequence: 'desc' },
    });

    if (latestStream) {
      await this.prisma.streamTask.update({
        where: { id: taskId },
        data: { currentRunId: latestStream.id },
      });
      return latestStream;
    }

    const stream = await this.prisma.streamTaskRun.create({
      data: {
        taskId,
        sequence: 1,
        trigger: INITIAL_STREAM_TRIGGER,
      },
    });
    await this.prisma.streamTask.update({
      where: { id: taskId },
      data: { currentRunId: stream.id },
    });
    return stream;
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
      streamId: string;
      conversationId: string;
      messageId: string;
      requestPayload: Prisma.JsonValue;
    },
    executionSignal: AbortSignal,
  ) {
    const payload = task.requestPayload as unknown as ChatTaskPayload;

    if (!payload.content) {
      throw new Error('Missing chat task payload');
    }

    const agentRun =
      await this.commonChatAgentRunnerService.prepareConversationRun({
        conversationId: task.conversationId,
        pendingMessageId: task.messageId,
        llm: payload.llm,
        abortSignal: executionSignal,
      });

    let fullContent = '';
    let deltaCount = 0;
    let emptyDeltaCount = 0;
    const startedAt = Date.now();

    this.debugTaskLog('stream_task.chat.agent_start', {
      taskId: task.id,
      conversationId: task.conversationId,
      messageId: task.messageId,
      messageCount: agentRun.messages.length,
      model: this.toSafeTaskModelLog(payload.llm),
      generation: payload.llm?.generation,
      hasSystemPrompt: Boolean(agentRun.systemPrompt),
      toolCount: agentRun.tools.length,
    });

    for await (const event of agentRun.events) {
      if (event.type === 'tool.call.delta') {
        await this.handleToolCallDeltaEvent(task, event);
        continue;
      }

      if (!event.delta) {
        emptyDeltaCount++;
        continue;
      }

      deltaCount++;
      fullContent += event.delta;
      const deltaEvent = await this.persistEvent(
        task.id,
        task.streamId,
        'message.delta',
        this.serializeTaskEventData({
          type: 'message.delta',
          taskId: task.id,
          streamId: task.streamId,
          conversationId: task.conversationId,
          messageId: task.messageId,
          status: StreamTaskStatus.STREAMING.toLowerCase(),
          payload: {
            delta: event.delta,
          },
        }),
        {
          fullContent,
          status: StreamTaskStatus.STREAMING,
        },
      );
      this.registry.publish(task.id, deltaEvent);
    }

    if (executionSignal.aborted) {
      throw executionSignal.reason;
    }

    const completionWarning =
      fullContent.trim().length === 0 ? EMPTY_ASSISTANT_CONTENT : undefined;
    const finalContent = completionWarning ?? fullContent;

    if (completionWarning) {
      this.logger.warn(
        this.formatTaskLog('stream_task.chat.empty_completion', {
          taskId: task.id,
          conversationId: task.conversationId,
          messageId: task.messageId,
          deltaCount,
          emptyDeltaCount,
          fullContentLength: fullContent.length,
          durationMs: Date.now() - startedAt,
        }),
      );
    } else {
      this.debugTaskLog('stream_task.chat.agent_completed', {
        taskId: task.id,
        conversationId: task.conversationId,
        messageId: task.messageId,
        deltaCount,
        emptyDeltaCount,
        fullContentLength: fullContent.length,
        durationMs: Date.now() - startedAt,
      });
    }

    const doneEvent = await this.persistEvent(
      task.id,
      task.streamId,
      'message.done',
      this.serializeTaskEventData({
        type: 'message.done',
        taskId: task.id,
        streamId: task.streamId,
        conversationId: task.conversationId,
        messageId: task.messageId,
        status: StreamTaskStatus.COMPLETED.toLowerCase(),
        payload: {
          content: finalContent,
          warning: completionWarning,
        },
      }),
      {
        fullContent: finalContent,
        status: StreamTaskStatus.COMPLETED,
      },
    );

    await this.prisma.$transaction([
      this.prisma.message.update({
        where: { id: task.messageId },
        data: {
          content: finalContent,
          status: MessageStatus.DONE,
        },
      }),
      this.prisma.conversation.update({
        where: { id: task.conversationId },
        data: { updatedAt: new Date() },
      }),
      this.prisma.streamTask.update({
        where: { id: task.id },
        data: {
          status: StreamTaskStatus.COMPLETED,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
          fullContent: finalContent,
          resultPayload: JSON.parse(
            JSON.stringify({
              content: finalContent,
              warning: completionWarning,
            }),
          ) as Prisma.JsonObject,
          currentStep: 'completed',
        },
      }),
    ]);

    this.registry.publish(task.id, doneEvent);

    const completedEvent = await this.persistEvent(
      task.id,
      task.streamId,
      'task.completed',
      this.serializeTaskEventData({
        type: 'task.completed',
        taskId: task.id,
        streamId: task.streamId,
        conversationId: task.conversationId,
        messageId: task.messageId,
        status: StreamTaskStatus.COMPLETED.toLowerCase(),
        payload: {
          warning: completionWarning,
          deltaCount,
          fullContentLength: finalContent.length,
        },
      }),
      {
        fullContent: finalContent,
        status: StreamTaskStatus.COMPLETED,
      },
    );
    this.registry.publish(task.id, completedEvent);

    await this.prisma.streamTaskRun.update({
      where: { id: task.streamId },
      data: {
        status: StreamTaskRunStatus.COMPLETED,
        endedAt: new Date(),
        closeReason: 'task_completed',
        endEventId: Number(completedEvent.id),
      },
    });

    void this.refreshConversationSummary(task.conversationId);
  }

  /**
   * 处理工具调用增量事件
   * @param task 聊天任务上下文
   * @param event agent 工具调用增量事件
   * @returns 无返回值
   * @description 将 agent 层的工具调用增量转发为 SSE 事件，后续工具执行和结果事件可以沿用同一通道扩展。
   */
  private async handleToolCallDeltaEvent(
    task: {
      id: string;
      streamId: string;
      conversationId: string;
      messageId: string;
    },
    event: Extract<CommonChatAgentStreamEvent, { type: 'tool.call.delta' }>,
  ) {
    const toolEvent = await this.persistEvent(
      task.id,
      task.streamId,
      'tool.call.delta',
      this.serializeTaskEventData({
        type: 'tool.call.delta',
        taskId: task.id,
        streamId: task.streamId,
        conversationId: task.conversationId,
        messageId: task.messageId,
        status: StreamTaskStatus.STREAMING.toLowerCase(),
        payload: {
          toolCallId: event.toolCallId,
          name: event.name,
          args: event.args,
          index: event.index,
        },
      }),
      {
        status: StreamTaskStatus.STREAMING,
      },
    );
    this.registry.publish(task.id, toolEvent);
  }

  /**
   * 刷新会话摘要
   * @param conversationId 会话ID
   * @returns 无返回值
   * @description 在回复完成后异步更新会话摘要，避免摘要生成阻塞当前 流式任务的完成事件返回。
   */
  private async refreshConversationSummary(conversationId: string) {
    try {
      await this.conversationSummaryService.refreshConversationSummary(
        conversationId,
      );
    } catch (error) {
      this.logger.warn(
        `Refresh conversation summary failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * 标记任务失败
   * @param taskId 任务ID
   * @param message 错误信息
   * @returns 无返回值
   * @description 将任务和对应消息更新为失败状态，同时写入并发布 task.error 事件。
   */
  private async failTask(taskId: string, message: string) {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
    });
    if (!task) {
      return;
    }

    const conversationId = this.requireConversationId(task);
    const messageId = this.requireMessageId(task);
    const errorEvent = await this.persistEvent(
      taskId,
      task.currentRunId,
      'task.error',
      this.serializeTaskEventData({
        type: 'task.error',
        taskId,
        streamId: task.currentRunId ?? undefined,
        conversationId,
        messageId,
        status: StreamTaskStatus.ERROR.toLowerCase(),
        errorMessage: message,
      }),
      {
        status: StreamTaskStatus.ERROR,
        errorMessage: message,
        fullContent: task.fullContent,
      },
    );

    await this.prisma.$transaction([
      this.prisma.streamTask.update({
        where: { id: taskId },
        data: {
          status: StreamTaskStatus.ERROR,
          errorMessage: message,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
          currentStep: 'error',
        },
      }),
      ...(task.currentRunId
        ? [
            this.prisma.streamTaskRun.update({
              where: { id: task.currentRunId },
              data: {
                status: StreamTaskRunStatus.ERROR,
                endedAt: new Date(),
                closeReason: 'task_error',
                endEventId: Number(errorEvent.id),
              },
            }),
          ]
        : []),
      this.prisma.message.update({
        where: { id: messageId },
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
   * @returns 返回包含稳定事件 ID 的流式事件对象
   * @description 为任务分配递增事件ID，更新任务游标和内容快照，并把事件写入 Redis 缓冲区供恢复重放。
   */
  private async persistEvent(
    taskId: string,
    streamId: string | null | undefined,
    event: string,
    data: string,
    taskUpdate?: Partial<{
      status: StreamTaskStatus;
      errorMessage: string | null;
      fullContent: string;
    }>,
  ) {
    const task = await this.prisma.streamTask.update({
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

    const eventPayload = this.parseEventPayload(data);
    await this.prisma.streamTaskEvent.create({
      data: {
        taskId,
        streamId,
        eventId: task.lastEventId,
        eventName: event,
        payload: eventPayload,
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
   * @returns 返回指定游标之后的流式事件列表
   * @description 从 Redis 缓冲区中读取任务未消费的历史事件，用于断线后的补发与重放。
   */
  private async getBufferedEventsAfter(taskId: string, lastEventId: number) {
    const persistedEvents = await this.prisma.streamTaskEvent.findMany({
      where: {
        taskId,
        eventId: {
          gt: lastEventId,
        },
      },
      orderBy: { eventId: 'asc' },
    });

    if (persistedEvents.length > 0) {
      return persistedEvents.map((event) => ({
        id: String(event.eventId),
        event: event.eventName,
        data: JSON.stringify(event.payload),
      }));
    }

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
    await this.prisma.streamTask.update({
      where: { id: taskId },
      data: { status: StreamTaskStatus.EXPIRED },
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
    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new NotFoundException('流式任务不存在');
    }

    if (task.userId !== userId) {
      throw new ForbiddenException('无权访问该 流式任务');
    }

    return task;
  }

  /**
   * 判断任务是否为终态
   * @param status 任务状态
   * @returns 返回布尔值，true 表示任务已结束
   * @description 用于统一判断任务是否已经进入 completed、error、expired 或 canceled 等终止状态。
   */
  private isTerminalStatus(status: StreamTaskStatus) {
    return (
      status === StreamTaskStatus.COMPLETED ||
      status === StreamTaskStatus.ERROR ||
      status === StreamTaskStatus.EXPIRED ||
      status === StreamTaskStatus.CANCELED
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

    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    });

    return task?.status === StreamTaskStatus.CANCELED;
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
   * 序列化任务事件数据
   * @param eventData 任务事件业务数据
   * @returns 返回可直接写入 SSE data 字段的 JSON 字符串
   * @description 为任务相关事件统一输出固定数据结构，避免不同事件的 payload 形状漂移。
   */
  private serializeTaskEventData<TPayload>(
    eventData: StreamTaskEventData<TPayload>,
  ) {
    return JSON.stringify(eventData);
  }

  private parseEventPayload(data: string): Prisma.InputJsonValue {
    try {
      return JSON.parse(data) as Prisma.InputJsonValue;
    } catch {
      return { raw: data };
    }
  }

  private formatTaskLog(event: string, payload: Record<string, unknown>) {
    return JSON.stringify({ event, ...payload });
  }

  private debugTaskLog(event: string, payload: Record<string, unknown>) {
    if (!this.isDebugEnabled()) {
      return;
    }

    this.logger.log(this.formatTaskLog(event, payload));
  }

  private toSafeTaskModelLog(llmRequest: ChatTaskPayload['llm']) {
    if (!llmRequest?.model) {
      return undefined;
    }

    return {
      id: llmRequest.model.id,
      provider: llmRequest.model.provider,
      platform: llmRequest.model.platform,
      model: llmRequest.model.model,
      baseURL: this.toSafeBaseUrl(llmRequest.model.baseURL),
      hasApiKey: Boolean(llmRequest.model.apiKey),
    };
  }

  private toSafeBaseUrl(baseURL: string | undefined) {
    if (!baseURL) {
      return undefined;
    }

    try {
      return new URL(baseURL).origin;
    } catch {
      return '[invalid-url]';
    }
  }

  private isDebugEnabled() {
    const value = this.configService.get<string>('LLM_DEBUG');
    return value === 'true' || value === '1';
  }

  /**
   * 构建任务流式事件对象
   * @param eventId 事件ID
   * @param eventName 流式事件名称
   * @param eventData 任务事件业务数据
   * @returns 返回包含标准 data JSON 的流式事件对象
   * @description 用于生成首包事件或单次事件流中的任务事件，确保 event 名和业务 type 字段保持一致。
   */
  private buildTaskSseEvent<TPayload>(
    eventId: string,
    eventName: string,
    eventData: Omit<StreamTaskEventData<TPayload>, 'type'>,
  ): SseEvent {
    return {
      id: eventId,
      event: eventName,
      data: this.serializeTaskEventData({
        type: eventName,
        ...eventData,
      }),
    };
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

  private requireConversationId(task: { conversationId: string | null }) {
    if (!task.conversationId) {
      throw new Error('Agent task is not bound to a conversation');
    }

    return task.conversationId;
  }

  private requireMessageId(task: { messageId: string | null }) {
    if (!task.messageId) {
      throw new Error('Agent task is not bound to a message');
    }

    return task.messageId;
  }

  /**
   * 包装单事件异步流
   * @param event 流式事件对象
   * @returns 返回只会产出单个事件的异步流
   * @description 用于过期等场景，将单个事件包装成符合流式输出约定的异步迭代器。
   */
  private singleEventStream(event: SseEvent): AsyncGenerator<SseEvent> {
    return (async function* () {
      await Promise.resolve();
      yield event;
    })();
  }

  /**
   * 在事件流前插入单个事件
   * @param initialEvent 首个需要插入的流式事件
   * @param stream 原始事件流
   * @returns 返回新的流式事件流
   * @description 用于在首轮聊天建链时先向客户端发送 task.created 事件，再继续产出任务自身的流式事件。
   */
  private async *prependEvent(
    initialEvent: SseEvent,
    stream: AsyncGenerator<SseEvent>,
  ): AsyncGenerator<SseEvent> {
    yield initialEvent;

    for await (const event of stream) {
      yield event;
    }
  }
}
