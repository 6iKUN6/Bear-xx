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
import { SSE_OPTIONS_KEY } from './sse.types';
import type { SseEvent, SseOptions, SseRequest } from './sse.types';
import type { Response } from 'express';

@Injectable()
export class SseInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SseInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
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

    // Abort controller for client disconnect
    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    // Attach signal to request for downstream use
    req.__sseAbortSignal = abortController.signal;

    const heartbeatMs =
      sseOptions.heartbeatMs ??
      this.configService.get<number>('SSE_HEARTBEAT_INTERVAL', 15000);
    const lastEventIdHeader = req.headers['last-event-id'] as
      string | undefined;
    const lastEventIdQuery = req.query.cursor;
    const lastEventIdBody =
      req.body && typeof req.body === 'object' && 'lastEventId' in req.body
        ? (req.body as Record<string, unknown>).lastEventId
        : undefined;
    const lastEventId =
      this.parseEventId(lastEventIdBody) ??
      this.parseEventId(
        typeof lastEventIdQuery === 'string' ? lastEventIdQuery : undefined,
      ) ??
      this.parseEventId(lastEventIdHeader);
    req.__sseLastEventId = lastEventId;

    return next.handle().pipe(
      switchMap(
        (
          result:
            { stream: AsyncGenerator<SseEvent> } | AsyncGenerator<SseEvent>,
        ) => {
          const stream = this.isAsyncGenerator(result) ? result : result.stream;
          this.prepareSseResponse(res);
          return from(
            this.handleSseStream(
              res,
              stream,
              abortController.signal,
              heartbeatMs,
            ),
          );
        },
      ),
      switchMap(() => EMPTY),
    );
  }

  private prepareSseResponse(res: Response) {
    if (res.headersSent) {
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  private async handleSseStream(
    res: Response,
    stream: AsyncGenerator<SseEvent>,
    signal: AbortSignal,
    heartbeatMs: number,
  ): Promise<void> {
    const writeSseEvent = (event: SseEvent) => {
      if (signal.aborted) return;
      res.write(`id: ${event.id}\n`);
      res.write(`event: ${event.event}\n`);
      res.write(`data: ${event.data}\n\n`);
    };

    const bufferEvent = (event: SseEvent) => {
      writeSseEvent(event);
    };

    try {
      const iterator = stream[Symbol.asyncIterator]();
      while (!signal.aborted) {
        const nextEvent = iterator.next();
        const result = await Promise.race([
          nextEvent,
          new Promise<{ heartbeat: true }>((resolve) =>
            setTimeout(() => resolve({ heartbeat: true }), heartbeatMs),
          ),
        ]);

        if ('heartbeat' in result) {
          res.write(': heartbeat\n\n');
          continue;
        }

        if (result.done) {
          break;
        }

        bufferEvent(result.value);
      }
    } catch (error) {
      this.logger.error(`SSE stream error: ${(error as Error).message}`);
    } finally {
      res.end();
    }
  }

  private parseEventId(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }

    const eventId = String(value).trim();
    return eventId.length > 0 ? eventId : undefined;
  }

  private isAsyncGenerator(
    result: { stream: AsyncGenerator<SseEvent> } | AsyncGenerator<SseEvent>,
  ): result is AsyncGenerator<SseEvent> {
    return (
      typeof (result as AsyncGenerator<SseEvent>)[Symbol.asyncIterator] ===
      'function'
    );
  }
}
