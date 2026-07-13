import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SseEvent } from '../../common/sse';
import { RedisService } from '../../redis/redis.service';

type RedisStreamEntry = [id: string, fields: string[]];
type RedisStreamReadResult = Array<[key: string, entries: RedisStreamEntry[]]>;

const DEFAULT_FRAME_MAXLEN = 10000;
const DEFAULT_FRAME_TTL_SECONDS = 300;
const DEFAULT_COMPLETED_FRAME_TTL_SECONDS = 600;
const DEFAULT_XREAD_BLOCK_MS = 15000;

@Injectable()
export class StreamTaskSnapshotService {
  private readonly logger = new Logger(StreamTaskSnapshotService.name);
  private readonly keyPrefix = 'stream-task:frames';
  private readonly frameMaxLen: number;
  private readonly frameTtlSeconds: number;
  private readonly completedFrameTtlSeconds: number;
  private readonly xreadBlockMs: number;

  constructor(
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.frameMaxLen =
      this.configService.get<number>('STREAM_TASK_FRAME_MAXLEN') ??
      DEFAULT_FRAME_MAXLEN;
    this.frameTtlSeconds =
      this.configService.get<number>('STREAM_TASK_FRAME_TTL') ??
      this.configService.get<number>(
        'STREAM_TASK_BUFFER_TTL',
        DEFAULT_FRAME_TTL_SECONDS,
      );
    this.completedFrameTtlSeconds =
      this.configService.get<number>('STREAM_TASK_FRAME_COMPLETED_TTL') ??
      DEFAULT_COMPLETED_FRAME_TTL_SECONDS;
    this.xreadBlockMs =
      this.configService.get<number>('STREAM_TASK_FRAME_XREAD_BLOCK_MS') ??
      DEFAULT_XREAD_BLOCK_MS;
  }

  /**
   * 读取当前已缓存的历史帧，不阻塞等待新内容。
   * 用于 resume 建链时先快速补齐断线期间 Redis 已收到的帧。
   */
  async readBufferedFramesAfter(
    taskId: string,
    afterFrameId: string | undefined,
    limit = 1000,
  ): Promise<SseEvent[]> {
    const cursor = this.normalizeFrameId(afterFrameId);
    const min = cursor === '0' ? '0' : `(${cursor}`;
    const result = (await this.redis.xrange(
      this.frameKey(taskId),
      min,
      '+',
      'COUNT',
      limit,
    )) as RedisStreamEntry[];

    return result
      .map(([id, fields]) => this.parseFrame(id, fields))
      .filter((event): event is SseEvent => Boolean(event));
  }

  /**
   * 将单帧 SSE 事件写入 Redis Stream。
   * 高频 token 增量只进入这里，用 Redis Stream ID 作为客户端断线恢复游标。
   */
  async appendFrame(
    taskId: string,
    eventName: string,
    data: string,
  ): Promise<SseEvent> {
    const frameId = await this.redis.xadd(
      this.frameKey(taskId),
      'MAXLEN',
      '~',
      this.frameMaxLen,
      '*',
      'event',
      eventName,
      'data',
      data,
    );

    if (!frameId) {
      throw new Error('Redis Stream frame append failed');
    }

    await this.redis.expire(this.frameKey(taskId), this.frameTtlSeconds);

    return {
      id: frameId,
      event: eventName,
      data,
    };
  }

  /**
   * 从指定 Redis Stream 游标之后持续读取帧。
   * 首次连接和断线重连都使用同一套逻辑：先补历史帧，再阻塞等待实时帧。
   */
  async *readFramesAfter(
    taskId: string,
    afterFrameId: string | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<SseEvent> {
    const reader = this.redis.duplicate();
    const key = this.frameKey(taskId);
    let cursor = this.normalizeFrameId(afterFrameId);

    try {
      while (!signal?.aborted) {
        const result = (await reader.xread(
          'BLOCK',
          this.xreadBlockMs,
          'STREAMS',
          key,
          cursor,
        )) as RedisStreamReadResult | null;

        if (!result) {
          continue;
        }

        for (const [, entries] of result) {
          for (const [id, fields] of entries) {
            cursor = id;
            const event = this.parseFrame(id, fields);
            if (!event) {
              continue;
            }

            yield event;
          }
        }
      }
    } catch (error) {
      if (!signal?.aborted) {
        this.logger.warn(
          `Read stream task frames failed: ${(error as Error).message}`,
        );
        throw error;
      }
    } finally {
      reader.disconnect();
    }
  }

  /**
   * 任务进入终态后缩短帧缓存窗口，供客户端短时间内恢复补帧。
   */
  async markCompleted(taskId: string) {
    await this.redis.expire(
      this.frameKey(taskId),
      this.completedFrameTtlSeconds,
    );
  }

  private frameKey(taskId: string) {
    return `${this.keyPrefix}:${taskId}`;
  }

  private normalizeFrameId(frameId: string | undefined) {
    const trimmed = frameId?.trim();
    return trimmed && trimmed !== '0' ? trimmed : '0';
  }

  private parseFrame(id: string, fields: string[]): SseEvent | null {
    const fieldMap = new Map<string, string>();
    for (let index = 0; index < fields.length; index += 2) {
      const key = fields[index];
      const value = fields[index + 1];
      if (key !== undefined && value !== undefined) {
        fieldMap.set(key, value);
      }
    }

    const event = fieldMap.get('event');
    const data = fieldMap.get('data');
    if (!event || data === undefined) {
      return null;
    }

    return { id, event, data };
  }
}
