import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, StreamTaskStatus } from '@prisma/client';
import {
  StreamTaskEventType,
  type StreamTaskPayloadMap,
} from '@litter-bear/types/protocol';
import { ConversationTraceService } from '../conversation-trace';
import { StreamTaskRegistry } from '../stream-task/stream-task.registry';
import { StreamTaskSnapshotService } from '../stream-task/stream-task-snapshot.service';

const DEFAULT_STREAM_TASK_BUFFER_TTL_SECONDS = 300;

/** 已写入 PostgreSQL、等待事务提交后发送的 Flow SSE 事件。 */
export interface PersistedAgentFlowTaskEvent {
  taskId: string;
  eventId: number;
  eventName: StreamTaskEventType;
  data: string;
  traceItemId?: string;
}

/** Flow 语义事件的事务写入参数。 */
export interface PersistAgentFlowTaskEventInput<K extends StreamTaskEventType> {
  taskId: string;
  streamId?: string | null;
  userId: string;
  conversationId: string;
  messageId: string;
  eventName: K;
  status: StreamTaskStatus;
  payload?: StreamTaskPayloadMap[K];
  errorMessage?: string;
  taskUpdate?: Prisma.StreamTaskUpdateInput;
}

/**
 * AgentFlow 任务事件投影服务
 * @description 集中处理 Flow 的低频事件持久化：先在调用方 PostgreSQL 事务内分配语义 eventId、更新 StreamTask、写 StreamTaskEvent 与 trace；只有事务提交后才写 Redis Stream 和本机 SSE 通道。
 */
@Injectable()
export class AgentFlowTaskEventService {
  private readonly bufferTtlSeconds: number;

  constructor(
    private readonly snapshotService: StreamTaskSnapshotService,
    private readonly registry: StreamTaskRegistry,
    private readonly conversationTraceService: ConversationTraceService,
    configService: ConfigService,
  ) {
    this.bufferTtlSeconds =
      configService.get<number>('STREAM_TASK_BUFFER_TTL') ??
      DEFAULT_STREAM_TASK_BUFFER_TTL_SECONDS;
  }

  /**
   * 在已有数据库事务内持久化一条 Flow 语义事件
   * @param transaction 当前业务事务客户端
   * @param input 任务上下文、事件载荷与可选任务状态更新
   * @returns 返回待事务提交后追加到 Redis 的事件草稿
   * @description 绝不在事务内访问 Redis。调用方必须在 `$transaction` 成功返回后调用 `publishAfterCommit`，从而避免客户端读到尚可回滚的事件。
   */
  async persistInTransaction<K extends StreamTaskEventType>(
    transaction: Prisma.TransactionClient,
    input: PersistAgentFlowTaskEventInput<K>,
  ): Promise<PersistedAgentFlowTaskEvent> {
    const data = JSON.stringify({
      type: input.eventName,
      taskId: input.taskId,
      streamId: input.streamId ?? undefined,
      conversationId: input.conversationId,
      messageId: input.messageId,
      status: input.status.toLowerCase(),
      payload: input.payload,
      errorMessage: input.errorMessage,
    });
    const now = new Date();
    const task = await transaction.streamTask.update({
      where: { id: input.taskId },
      data: {
        lastEventId: { increment: 1 },
        lastHeartbeatAt: now,
        expiresAt: new Date(now.getTime() + this.bufferTtlSeconds * 1000),
        status: input.status,
        ...input.taskUpdate,
      },
      select: { lastEventId: true },
    });
    await transaction.streamTaskEvent.create({
      data: {
        taskId: input.taskId,
        streamId: input.streamId,
        eventId: task.lastEventId,
        eventName: input.eventName,
        payload: this.toInputJsonValue(data),
      },
    });
    const traceItem =
      await this.conversationTraceService.recordStreamEventInTransaction(
        transaction,
        {
          userId: input.userId,
          taskId: input.taskId,
          runId: input.streamId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          eventName: input.eventName,
          payload: input.payload,
          errorMessage: input.errorMessage,
        },
      );

    return {
      taskId: input.taskId,
      eventId: task.lastEventId,
      eventName: input.eventName,
      data,
      ...(traceItem?.id ? { traceItemId: traceItem.id } : {}),
    };
  }

  /**
   * 在事务提交后发布一条 Flow 事件
   * @param event 已完成持久化的 Flow 事件草稿
   * @returns 无返回值
   * @description Redis Stream ID 是客户端回放游标，与 PostgreSQL 的 eventId 分离；写入 Redis 成功后再通知当前进程的实时 SSE 订阅者。
   */
  async publishAfterCommit(event: PersistedAgentFlowTaskEvent): Promise<void> {
    const sseEvent = await this.snapshotService.appendFrame(
      event.taskId,
      event.eventName,
      event.data,
    );
    this.registry.publish(event.taskId, sseEvent);
  }

  /**
   * 发布不进入 PostgreSQL 的高频消息增量帧
   * @param taskId 当前 Flow 任务ID
   * @param eventName 高频事件名称
   * @param data 已序列化的标准 SSE 数据包络
   * @returns 无返回值
   * @description `message.delta` 不创建 StreamTaskEvent 或 trace；它只追加 Redis Stream，客户端仍以 Redis Stream ID 作为断线恢复游标。
   */
  async publishTransient(
    taskId: string,
    eventName: StreamTaskEventType.MessageDelta,
    data: string,
  ): Promise<void> {
    const sseEvent = await this.snapshotService.appendFrame(
      taskId,
      eventName,
      data,
    );
    this.registry.publish(taskId, sseEvent);
  }

  /**
   * 标记任务的 Redis 帧已进入终态缓存窗口
   * @param taskId 当前 Flow 任务ID
   * @returns 无返回值
   * @description 终态事件已经事务提交并写入 Redis 后调用，沿用 StreamTask 的较短完成窗口，避免完成任务长期占用高频帧缓存。
   */
  markCompletedAfterCommit(taskId: string): Promise<void> {
    return this.snapshotService.markCompleted(taskId);
  }

  /**
   * 将 JSON 字符串转换为 Prisma Json 输入值
   * @param data 已由本服务序列化的事件 JSON 字符串
   * @returns 返回可安全写入 Json 列的普通 JSON 值
   * @description 事件数据先走 JSON 序列化以删除 undefined，随后再解析为 Prisma 支持的 JSON 值；该转换不接收调用方提供的任意对象。
   */
  private toInputJsonValue(data: string): Prisma.InputJsonValue {
    return JSON.parse(data) as Prisma.InputJsonValue;
  }
}
