import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Observable, from, EMPTY } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { RedisService } from '../../redis/redis.service';
import { SSE_OPTIONS_KEY } from './sse.types';
import type { SseEvent, SseOptions, SseRequest } from './sse.types';
import type { Response } from 'express';

interface SseResult {
  bufferKey: string;
  stream: AsyncGenerator<SseEvent>;
}

@Injectable()
export class SseInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SseInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const sseOptions = this.reflector.get<SseOptions | undefined>(
      SSE_OPTIONS_KEY,
      context.getHandler(),
    );

    // Not an SSE endpoint — pass through
    if (sseOptions === undefined) {
      return next.handle();
    }

    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest<SseRequest>();
    const res = httpCtx.getResponse<Response>();

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Abort controller for client disconnect
    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    // Attach signal to request for downstream use
    req.__sseAbortSignal = abortController.signal;

    const heartbeatMs =
      sseOptions.heartbeatMs ??
      this.configService.get<number>('SSE_HEARTBEAT_INTERVAL', 15000);
    const bufferTtl =
      sseOptions.bufferTtl ??
      this.configService.get<number>('SSE_BUFFER_TTL', 300);
    const bufferKeyPrefix = sseOptions.bufferKeyPrefix ?? 'sse:buffer';

    // Parse Last-Event-ID
    const lastEventIdHeader = req.headers['last-event-id'] as
      | string
      | undefined;
    const lastEventId = lastEventIdHeader
      ? Number(lastEventIdHeader)
      : undefined;

    return next.handle().pipe(
      switchMap((result: SseResult) => {
        // The controller returns { bufferKey, stream } or just an AsyncGenerator
        return from(
          this.handleSseStream(
            res,
            result,
            abortController.signal,
            heartbeatMs,
            bufferTtl,
            bufferKeyPrefix,
            lastEventId,
          ),
        );
      }),
      switchMap(() => EMPTY),
    );
  }

  private async handleSseStream(
    res: Response,
    result: { bufferKey: string; stream: AsyncGenerator<SseEvent> },
    signal: AbortSignal,
    heartbeatMs: number,
    bufferTtl: number,
    bufferKeyPrefix: string,
    lastEventId?: number,
  ): Promise<void> {
    const { bufferKey, stream } = result;
    const fullBufferKey = `${bufferKeyPrefix}:${bufferKey}`;

    const writeSseEvent = (event: SseEvent) => {
      if (signal.aborted) return;
      res.write(`id: ${event.id}\n`);
      res.write(`event: ${event.event}\n`);
      res.write(`data: ${event.data}\n\n`);
    };

    // --- Reconnection: replay missed events from Redis buffer ---
    if (lastEventId !== undefined) {
      const exists = await this.redis.exists(fullBufferKey).catch(() => 0);

      if (!exists) {
        // Buffer expired — inform client
        writeSseEvent({
          id: String(lastEventId + 1),
          event: 'expired',
          data: JSON.stringify({ message: '会话缓冲已过期，请重新发送' }),
        });
        res.end();
        return;
      }

      // Replay events after lastEventId
      const missed = await this.redis
        .zrangebyscore(fullBufferKey, lastEventId + 1, '+inf')
        .catch(() => [] as string[]);

      for (const raw of missed) {
        if (signal.aborted) break;
        try {
          const event = JSON.parse(raw) as SseEvent;
          writeSseEvent(event);
        } catch {
          // skip malformed entries
        }
      }

      // Check if stream already completed (last event was 'done' or 'error')
      if (missed.length > 0) {
        try {
          const lastEvent = JSON.parse(missed[missed.length - 1]) as SseEvent;
          if (lastEvent.event === 'done' || lastEvent.event === 'error') {
            res.end();
            return;
          }
        } catch {
          // continue to live stream
        }
      }
    }

    // --- Live stream with heartbeat ---
    let lastSendTime = Date.now();
    let pendingHeartbeat = false;
    let eventIdCounter = lastEventId ?? 0;

    const heartbeatTimer = setInterval(() => {
      if (Date.now() - lastSendTime >= heartbeatMs) {
        pendingHeartbeat = true;
      }
    }, heartbeatMs);

    const bufferEvent = (event: SseEvent) => {
      this.redis
        .zadd(fullBufferKey, Number(event.id), JSON.stringify(event))
        .catch(() => {});
      this.redis.expire(fullBufferKey, bufferTtl).catch(() => {});
      lastSendTime = Date.now();
    };

    try {
      for await (const event of stream) {
        if (signal.aborted) break;

        // Emit pending heartbeat
        if (pendingHeartbeat) {
          const hbEvent: SseEvent = {
            id: String(++eventIdCounter),
            event: 'heartbeat',
            data: '',
          };
          writeSseEvent(hbEvent);
          bufferEvent(hbEvent);
          pendingHeartbeat = false;
        }

        // Re-assign sequential id
        const sseEvent: SseEvent = {
          ...event,
          id: String(++eventIdCounter),
        };
        writeSseEvent(sseEvent);
        bufferEvent(sseEvent);
      }
    } catch (error) {
      this.logger.error(`SSE stream error: ${(error as Error).message}`);
    } finally {
      clearInterval(heartbeatTimer);
      res.end();
    }
  }
}
