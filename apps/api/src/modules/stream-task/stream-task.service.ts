import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ApprovalDecision,
  TaskErrorPayload,
} from '@litter-bear/types/protocol';
import { classifyLlmError } from '../llm/llm-error';
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
import { CommonChatAgentRunnerService } from '../ai/agents';
import type { AgentLoopStreamEvent } from '../ai/agent-loop';
import type {
  LlmMessage,
  LlmRunMetrics,
  LlmTextRequest,
  ResolvedLlmTextRequest,
} from '../llm/llm.types';
import { LlmService } from '../llm/llm.service';
import { ConversationService } from '../conversation/conversation.service';
import { ConversationTraceService } from '../conversation-trace';
import type { ChatContextBundle } from '../memory/chat-context.service';
import { ConversationSummaryService } from '../memory/conversation-summary.service';
import {
  STREAM_TASK_TERMINAL_EVENT_TYPES,
  StreamTaskEventType,
} from './stream-task-event.types';
import { StreamTaskRegistry } from './stream-task.registry';
import { StreamTaskSnapshotService } from './stream-task-snapshot.service';

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
  type: StreamTaskEventType;
  taskId: string;
  streamId?: string;
  conversationId: string;
  messageId: string;
  status: string;
  payload?: TPayload;
  errorMessage?: string;
}

interface PersistedSemanticEvent {
  eventId: number;
  sseEvent: SseEvent;
}

export interface TaskStreamResult {
  stream: AsyncGenerator<SseEvent>;
}

const TASK_CANCELED_REASON = 'task_canceled';
const EMPTY_ASSISTANT_CONTENT =
  '模型本次没有返回有效文本。请检查模型名称、中转站响应格式或流式输出配置。';

const INITIAL_STREAM_TRIGGER = 'initial';
const FULL_CONTENT_FLUSH_INTERVAL_MS = 1000;
const FULL_CONTENT_FLUSH_CHARS = 2048;

@Injectable()
export class StreamTaskService {
  private readonly logger = new Logger(StreamTaskService.name);
  private readonly bufferTtl: number;
  private readonly lockKeyPrefix = 'stream-task:lock';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly aiService: AiService,
    private readonly commonChatAgentRunnerService: CommonChatAgentRunnerService,
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
    private readonly conversationService: ConversationService,
    private readonly conversationTraceService: ConversationTraceService,
    private readonly conversationSummaryService: ConversationSummaryService,
    private readonly registry: StreamTaskRegistry,
    private readonly snapshotService: StreamTaskSnapshotService,
  ) {
    this.bufferTtl =
      this.configService.get<number>('STREAM_TASK_BUFFER_TTL') ??
      this.configService.get<number>('SSE_BUFFER_TTL', 300);
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
      '0',
      signal,
    );

    return {
      stream: this.prependEvent(
        this.buildTaskSseEvent('0', StreamTaskEventType.TaskCreated, {
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
      StreamTaskEventType.TaskCanceled,
      this.serializeTaskEventData({
        type: StreamTaskEventType.TaskCanceled,
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
                endEventId: event.eventId,
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

    await this.snapshotService.markCompleted(taskId);
    this.registry.publish(taskId, event.sseEvent);
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
    lastEventId: string,
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
          this.buildTaskSseEvent(
            this.nextSyntheticFrameId(lastEventId),
            StreamTaskEventType.TaskExpired,
            {
              taskId,
              streamId: task.currentRunId ?? undefined,
              conversationId: this.requireConversationId(task),
              messageId: this.requireMessageId(task),
              status: StreamTaskStatus.EXPIRED.toLowerCase(),
            },
          ),
        ),
      };
    }

    const stream = this.createTaskStream(task.id, lastEventId, signal);
    return { stream };
  }

  /**
   * 提交人工审批决定并恢复流式任务（HITL）
   * @param taskId 任务ID
   * @param userId 用户ID
   * @param decision 人工审批决定（approve/reject/edit）
   * @param lastEventId 客户端已接收的最后事件ID
   * @param signal 连接中断信号
   * @returns 返回续跑的 SSE 事件流
   * @description 仅对处于 WAITING_HUMAN 的任务生效：持久化决定后复用任务执行/流式机制，
   * 由 runChatTask 检测到决定后走 Command 恢复续跑。
   */
  async resumeTaskWithDecision(
    taskId: string,
    userId: string,
    decision: ApprovalDecision,
    lastEventId: string,
    signal?: AbortSignal,
  ): Promise<TaskStreamResult> {
    const task = await this.loadTask(taskId, userId);

    if (task.status !== StreamTaskStatus.WAITING_HUMAN) {
      throw new BadRequestException('任务当前不处于待人工审批状态');
    }

    await this.storePendingApprovalDecision(taskId, decision);

    const stream = this.createTaskStream(task.id, lastEventId, signal);
    return { stream };
  }

  /**
   * 暂存人工审批决定
   * @description 写入 Redis（TTL 复用缓冲期），供后台恢复执行读取一次后消费。
   */
  private async storePendingApprovalDecision(
    taskId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.redis.set(
      `hitl:approval:${taskId}`,
      JSON.stringify(decision),
      'EX',
      this.bufferTtl,
    );
  }

  /**
   * 读取并消费待处理的人工审批决定
   * @returns 存在则返回决定并从 Redis 删除；否则返回 undefined
   */
  private async readPendingApprovalDecision(
    taskId: string,
  ): Promise<ApprovalDecision | undefined> {
    const key = `hitl:approval:${taskId}`;
    const raw = await this.redis.get(key);
    if (!raw) {
      return undefined;
    }
    await this.redis.del(key);
    try {
      return JSON.parse(raw) as ApprovalDecision;
    } catch {
      return undefined;
    }
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
    lastEventId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<SseEvent> {
    let lastSeenFrameId = this.normalizeFrameId(lastEventId);

    const replayed = await this.snapshotService.readBufferedFramesAfter(
      taskId,
      lastSeenFrameId,
    );
    for (const event of replayed) {
      lastSeenFrameId = event.id;
      yield event;
      if (this.isTerminalEvent(event.event)) {
        return;
      }
    }

    const currentTask = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
    });
    if (currentTask && this.isTerminalStatus(currentTask.status)) {
      yield* this.buildTerminalFallbackStream(currentTask, lastSeenFrameId);
      return;
    }

    await this.ensureTaskExecution(taskId);

    for await (const event of this.snapshotService.readFramesAfter(
      taskId,
      lastSeenFrameId,
      signal,
    )) {
      yield event;

      if (this.isTerminalEvent(event.event)) {
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
        StreamTaskEventType.TaskStarted,
        this.serializeTaskEventData({
          type: StreamTaskEventType.TaskStarted,
          taskId,
          streamId: stream.id,
          conversationId,
          messageId,
          status: StreamTaskStatus.STREAMING.toLowerCase(),
        }),
      );
      await this.recordConversationTraceEvent({
        userId: task.userId,
        taskId,
        streamId: stream.id,
        conversationId,
        messageId,
        eventName: StreamTaskEventType.TaskStarted,
      });
      this.registry.publish(taskId, startedEvent.sseEvent);

      if (
        task.type === StreamTaskType.CHAT_COMPLETION ||
        task.type === StreamTaskType.VOICE_COMPLETION
      ) {
        await this.runChatTask(
          {
            id: task.id,
            userId: task.userId,
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

      const classified = classifyLlmError(error);
      this.logger.error(
        `Stream task failed: ${classified.message} (category=${classified.category}, status=${classified.status ?? 'n/a'})`,
      );
      await this.failTask(taskId, classified.message, {
        category: classified.category,
        retryable: classified.retryable,
        status: classified.status,
      });
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
      userId: string;
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

    // HITL：存在待处理的人工审批决定 → 走恢复路径（Command 续跑）；否则首轮执行。
    const approvalDecision = await this.readPendingApprovalDecision(task.id);
    const agentRun = approvalDecision
      ? await this.commonChatAgentRunnerService.resumeConversationRun({
          conversationId: task.conversationId,
          pendingMessageId: task.messageId,
          llm: payload.llm,
          taskId: task.id,
          decision: approvalDecision,
          abortSignal: executionSignal,
        })
      : await this.commonChatAgentRunnerService.prepareConversationRun({
          conversationId: task.conversationId,
          pendingMessageId: task.messageId,
          llm: payload.llm,
          taskId: task.id,
          abortSignal: executionSignal,
        });

    let fullContent = '';
    let deltaCount = 0;
    let emptyDeltaCount = 0;
    let pendingApproval = false;
    let lastFullContentFlushAt = Date.now();
    let lastFlushedFullContentLength = 0;
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
      hasSummary: Boolean(agentRun.context.summary),
      summaryMessageCount: agentRun.context.summary?.messageCount,
      recentMessageCount: agentRun.context.recentWindow.messageCount,
      recentMessageLimit: agentRun.context.recentWindow.limit,
    });

    for await (const event of agentRun.events) {
      if (event.type === StreamTaskEventType.ToolCallDelta) {
        await this.handleToolCallDeltaEvent(task, event);
        continue;
      }

      if (event.type !== StreamTaskEventType.MessageDelta) {
        if (event.type === StreamTaskEventType.ApprovalRequired) {
          pendingApproval = true;
        }
        await this.handleAgentLoopStatusEvent(task, event);
        continue;
      }

      if (!event.delta) {
        emptyDeltaCount++;
        continue;
      }

      deltaCount++;
      fullContent += event.delta;
      const deltaEvent = await this.publishFrame(
        task.id,
        StreamTaskEventType.MessageDelta,
        this.serializeTaskEventData({
          type: StreamTaskEventType.MessageDelta,
          taskId: task.id,
          streamId: task.streamId,
          conversationId: task.conversationId,
          messageId: task.messageId,
          status: StreamTaskStatus.STREAMING.toLowerCase(),
          payload: {
            delta: event.delta,
          },
        }),
      );
      const flushResult = await this.maybeFlushFullContent({
        taskId: task.id,
        fullContent,
        lastFlushAt: lastFullContentFlushAt,
        lastFlushedLength: lastFlushedFullContentLength,
      });
      lastFullContentFlushAt = flushResult.lastFlushAt;
      lastFlushedFullContentLength = flushResult.lastFlushedLength;
      this.registry.publish(task.id, deltaEvent);
    }

    if (executionSignal.aborted) {
      throw executionSignal.reason;
    }

    // HITL：agent 在工具执行前中断并已发出 approval.required。任务转入等待人工审批，
    // 不落 message.done / COMPLETED；由 :taskId/approval 端点带人工决定恢复续跑。
    if (pendingApproval) {
      await this.prisma.streamTask.update({
        where: { id: task.id },
        data: {
          status: StreamTaskStatus.WAITING_HUMAN,
          fullContent,
          currentStep: 'waiting_human',
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
        },
      });
      this.debugTaskLog('stream_task.chat.waiting_human', {
        taskId: task.id,
        conversationId: task.conversationId,
        messageId: task.messageId,
        deltaCount,
        fullContentLength: fullContent.length,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const completionWarning =
      fullContent.trim().length === 0 ? EMPTY_ASSISTANT_CONTENT : undefined;
    const finalContent = completionWarning ?? fullContent;
    const runMetrics = this.buildChatRunMetrics(
      agentRun.messages,
      finalContent,
      agentRun.context,
      Date.now() - startedAt,
    );

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
      StreamTaskEventType.MessageDone,
      this.serializeTaskEventData({
        type: StreamTaskEventType.MessageDone,
        taskId: task.id,
        streamId: task.streamId,
        conversationId: task.conversationId,
        messageId: task.messageId,
        status: StreamTaskStatus.COMPLETED.toLowerCase(),
        payload: {
          content: finalContent,
          warning: completionWarning,
          metrics: runMetrics,
        },
      }),
      {
        fullContent: finalContent,
        status: StreamTaskStatus.COMPLETED,
      },
    );
    await this.recordConversationTraceEvent({
      taskId: task.id,
      userId: task.userId,
      streamId: task.streamId,
      conversationId: task.conversationId,
      messageId: task.messageId,
      eventName: StreamTaskEventType.MessageDone,
      payload: {
        content: finalContent,
        warning: completionWarning,
        metrics: runMetrics,
      },
    });

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
              metrics: runMetrics,
            }),
          ) as Prisma.JsonObject,
          currentStep: 'completed',
        },
      }),
    ]);

    this.registry.publish(task.id, doneEvent.sseEvent);

    const completedEvent = await this.persistEvent(
      task.id,
      task.streamId,
      StreamTaskEventType.TaskCompleted,
      this.serializeTaskEventData({
        type: StreamTaskEventType.TaskCompleted,
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
    await this.recordConversationTraceEvent({
      taskId: task.id,
      userId: task.userId,
      streamId: task.streamId,
      conversationId: task.conversationId,
      messageId: task.messageId,
      eventName: StreamTaskEventType.TaskCompleted,
      payload: {
        warning: completionWarning,
        deltaCount,
        fullContentLength: finalContent.length,
      },
    });
    this.registry.publish(task.id, completedEvent.sseEvent);
    await this.snapshotService.markCompleted(task.id);

    await this.prisma.streamTaskRun.update({
      where: { id: task.streamId },
      data: {
        status: StreamTaskRunStatus.COMPLETED,
        endedAt: new Date(),
        closeReason: 'task_completed',
        endEventId: completedEvent.eventId,
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
      userId: string;
      streamId: string;
      conversationId: string;
      messageId: string;
    },
    event: Extract<
      AgentLoopStreamEvent,
      { type: StreamTaskEventType.ToolCallDelta }
    >,
  ) {
    const toolEvent = await this.publishFrame(
      task.id,
      StreamTaskEventType.ToolCallDelta,
      this.serializeTaskEventData({
        type: StreamTaskEventType.ToolCallDelta,
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
    );
    await this.recordConversationTraceEvent({
      taskId: task.id,
      userId: task.userId,
      streamId: task.streamId,
      conversationId: task.conversationId,
      messageId: task.messageId,
      eventName: StreamTaskEventType.ToolCallDelta,
      payload: {
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        index: event.index,
      },
    });
    this.registry.publish(task.id, toolEvent);
  }

  /**
   * 处理 agent loop 状态事件
   * @param task 聊天任务上下文
   * @param event agent loop 状态事件
   * @returns 无返回值
   * @description 将策略选择、工作流步骤、模型调用等非文本事件转发为 SSE 事件，供前端展示当前 loop 正在做的事情。
   */
  private async handleAgentLoopStatusEvent(
    task: {
      id: string;
      userId: string;
      streamId: string;
      conversationId: string;
      messageId: string;
    },
    event: Exclude<
      AgentLoopStreamEvent,
      | { type: StreamTaskEventType.MessageDelta }
      | { type: StreamTaskEventType.ToolCallDelta }
    >,
  ) {
    const statusEvent = await this.persistEvent(
      task.id,
      task.streamId,
      event.type,
      this.serializeTaskEventData({
        type: event.type,
        taskId: task.id,
        streamId: task.streamId,
        conversationId: task.conversationId,
        messageId: task.messageId,
        status: StreamTaskStatus.STREAMING.toLowerCase(),
        payload: event.payload,
      }),
      {
        status: StreamTaskStatus.STREAMING,
      },
    );
    await this.recordConversationTraceEvent({
      taskId: task.id,
      userId: task.userId,
      streamId: task.streamId,
      conversationId: task.conversationId,
      messageId: task.messageId,
      eventName: event.type,
      payload: event.payload,
    });
    this.registry.publish(task.id, statusEvent.sseEvent);
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
   * 构建单轮聊天运行指标
   * @param messages 模型输入消息
   * @param finalContent 最终回复内容
   * @param context 会话上下文包
   * @param durationMs 本轮生成耗时
   * @returns 返回 token 和缓存命中指标
   * @description 当前流式 provider usage 尚未稳定透出时，先记录估算 token 与 memory summary 命中，供 trace 入库和前端展示。
   */
  private buildChatRunMetrics(
    messages: LlmMessage[],
    finalContent: string,
    context: ChatContextBundle,
    durationMs: number,
  ): LlmRunMetrics {
    const memorySummaryHit = Boolean(context.summary);
    const cachedInputTokens = memorySummaryHit
      ? this.llmService.estimateTextTokenCount(context.summary?.content ?? '')
      : 0;

    return {
      tokenUsage: this.llmService.buildEstimatedTokenUsage(
        messages,
        finalContent,
        cachedInputTokens,
      ),
      cache: {
        memorySummaryHit,
        contextCacheHit: memorySummaryHit,
        cachedInputTokens,
      },
      durationMs,
      messageCount: messages.length,
      summaryMessageCount: context.summary?.messageCount,
      recentMessageCount: context.recentWindow.messageCount,
    };
  }

  /**
   * 标记任务失败
   * @param taskId 任务ID
   * @param message 错误信息
   * @returns 无返回值
   * @description 将任务和对应消息更新为失败状态，同时写入并发布 task.error 事件。
   */
  private async failTask(
    taskId: string,
    message: string,
    errorInfo?: TaskErrorPayload,
  ) {
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
      StreamTaskEventType.TaskError,
      this.serializeTaskEventData<TaskErrorPayload>({
        type: StreamTaskEventType.TaskError,
        taskId,
        streamId: task.currentRunId ?? undefined,
        conversationId,
        messageId,
        status: StreamTaskStatus.ERROR.toLowerCase(),
        errorMessage: message,
        payload: errorInfo,
      }),
      {
        status: StreamTaskStatus.ERROR,
        errorMessage: message,
        fullContent: task.fullContent,
      },
    );
    await this.recordConversationTraceEvent({
      userId: task.userId,
      taskId,
      streamId: task.currentRunId,
      conversationId,
      messageId,
      eventName: StreamTaskEventType.TaskError,
      errorMessage: message,
    });

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
                endEventId: errorEvent.eventId,
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

    await this.snapshotService.markCompleted(taskId);
    this.registry.publish(taskId, errorEvent.sseEvent);
  }

  /**
   * 持久化任务事件
   * @param taskId 任务ID
   * @param event 事件名
   * @param data 事件数据
   * @param taskUpdate 任务字段更新内容
   * @returns 返回数据库语义事件 ID 和 Redis Stream 帧
   * @description 仅用于低频语义事件：为任务分配递增事件 ID、写入事件表，并同步写入 Redis Stream 供 SSE 恢复重放。高频 message.delta 不应调用此方法。
   */
  private async persistEvent(
    taskId: string,
    streamId: string | null | undefined,
    event: StreamTaskEventType,
    data: string,
    taskUpdate?: Partial<{
      status: StreamTaskStatus;
      errorMessage: string | null;
      fullContent: string;
    }>,
  ): Promise<PersistedSemanticEvent> {
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

    const sseEvent = await this.publishFrame(taskId, event, data);

    return {
      eventId: task.lastEventId,
      sseEvent,
    };
  }

  /**
   * 发布一帧可恢复 SSE 事件。
   * 高频内容帧只写入 Redis Stream，避免把 token 级快照写入数据库。
   */
  private async publishFrame(
    taskId: string,
    event: StreamTaskEventType,
    data: string,
  ): Promise<SseEvent> {
    return this.snapshotService.appendFrame(taskId, event, data);
  }

  /**
   * 按时间或内容长度阈值刷新任务累计文本。
   * 运行时仍在内存中拼接 fullContent，但数据库不再每个 token 都更新。
   */
  private async maybeFlushFullContent(input: {
    taskId: string;
    fullContent: string;
    lastFlushAt: number;
    lastFlushedLength: number;
  }) {
    const now = Date.now();
    const contentGrowth = input.fullContent.length - input.lastFlushedLength;
    const shouldFlush =
      contentGrowth >= FULL_CONTENT_FLUSH_CHARS ||
      now - input.lastFlushAt >= FULL_CONTENT_FLUSH_INTERVAL_MS;

    if (!shouldFlush) {
      return {
        lastFlushAt: input.lastFlushAt,
        lastFlushedLength: input.lastFlushedLength,
      };
    }

    await this.prisma.streamTask.update({
      where: { id: input.taskId },
      data: {
        fullContent: input.fullContent,
        status: StreamTaskStatus.STREAMING,
        lastHeartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
      },
    });

    return {
      lastFlushAt: now,
      lastFlushedLength: input.fullContent.length,
    };
  }

  /**
   * 写入单轮对话轨迹
   * @param input 任务事件和上下文
   * @returns 无返回值
   * @description 将关键 StreamTask 事件交给 ConversationTraceService 归约为历史可回显的执行轨迹；失败不影响主流式链路。
   */
  private async recordConversationTraceEvent(input: {
    userId?: string;
    taskId: string;
    streamId?: string | null;
    conversationId: string;
    messageId: string;
    eventName: StreamTaskEventType;
    payload?: Record<string, unknown>;
    errorMessage?: string;
  }) {
    const userId = input.userId ?? (await this.resolveTaskUserId(input.taskId));
    await this.conversationTraceService.recordStreamEvent({
      userId,
      taskId: input.taskId,
      runId: input.streamId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      eventName: input.eventName,
      payload: input.payload,
      errorMessage: input.errorMessage,
    });
  }

  /**
   * 查询任务所属用户
   * @param taskId 任务ID
   * @returns 返回用户ID；任务不存在时返回 undefined
   * @description trace 写入需要 userId 作为归属字段，部分内部调用只有 taskId，因此在写入前懒查询一次。
   */
  private async resolveTaskUserId(taskId: string) {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
      select: { userId: true },
    });
    return task?.userId;
  }

  /**
   * 终态任务恢复兜底流。
   * Redis 帧缓存过期后，不再尝试还原完整增量帧，只返回最终正文和终态，避免客户端恢复请求长期挂起。
   */
  private *buildTerminalFallbackStream(
    task: {
      id: string;
      status: StreamTaskStatus;
      currentRunId: string | null;
      conversationId: string | null;
      messageId: string | null;
      fullContent: string;
      errorMessage: string | null;
      resultPayload: Prisma.JsonValue | null;
    },
    frameId: string,
  ): Generator<SseEvent> {
    const conversationId = this.requireConversationId(task);
    const messageId = this.requireMessageId(task);
    const eventId = this.normalizeFrameId(frameId);

    if (task.status === StreamTaskStatus.COMPLETED) {
      const resultPayload = this.toRecord(task.resultPayload);
      const content =
        typeof resultPayload.content === 'string'
          ? resultPayload.content
          : task.fullContent;

      yield this.buildTaskSseEvent(eventId, StreamTaskEventType.MessageDone, {
        taskId: task.id,
        streamId: task.currentRunId ?? undefined,
        conversationId,
        messageId,
        status: task.status.toLowerCase(),
        payload: {
          content,
          warning:
            typeof resultPayload.warning === 'string'
              ? resultPayload.warning
              : undefined,
          metrics: this.toRecord(resultPayload.metrics),
        },
      });

      yield this.buildTaskSseEvent(eventId, StreamTaskEventType.TaskCompleted, {
        taskId: task.id,
        streamId: task.currentRunId ?? undefined,
        conversationId,
        messageId,
        status: task.status.toLowerCase(),
      });
      return;
    }

    const terminalEvent =
      task.status === StreamTaskStatus.CANCELED
        ? StreamTaskEventType.TaskCanceled
        : task.status === StreamTaskStatus.EXPIRED
          ? StreamTaskEventType.TaskExpired
          : StreamTaskEventType.TaskError;

    yield this.buildTaskSseEvent(eventId, terminalEvent, {
      taskId: task.id,
      streamId: task.currentRunId ?? undefined,
      conversationId,
      messageId,
      status: task.status.toLowerCase(),
      errorMessage: task.errorMessage ?? undefined,
    });
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
   * 判断事件是否为任务终态事件
   * @param event 事件名称
   * @returns 返回布尔值，true 表示该事件会结束当前 SSE 流
   * @description 仅 StreamTask 协议枚举中的终态事件会结束恢复流；未知字符串事件不会被当成终态处理。
   */
  private isTerminalEvent(event: string) {
    return STREAM_TASK_TERMINAL_EVENT_TYPES.has(event as StreamTaskEventType);
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

  private normalizeFrameId(frameId: string | undefined) {
    const trimmed = frameId?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : '0';
  }

  private nextSyntheticFrameId(frameId: string | undefined) {
    return this.normalizeFrameId(frameId);
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value as Record<string, unknown>;
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
    eventName: StreamTaskEventType,
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
