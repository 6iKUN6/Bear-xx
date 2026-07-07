import {
  SetMetadata,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { SSE_OPTIONS_KEY, SSE_LAST_EVENT_ID_KEY } from './sse.types';
import type { SseOptions } from './sse.types';

/**
 * Marks an endpoint as SSE streaming.
 * The decorated method should return an AsyncGenerator<SseEvent>.
 * The interceptor handles: SSE headers, heartbeat, Redis buffering, reconnection replay.
 */
export function Sse(options?: SseOptions): MethodDecorator {
  return SetMetadata(SSE_OPTIONS_KEY, options ?? {});
}

/**
 * Extracts `Last-Event-ID` header from the request.
 * Returns the raw cursor value or undefined if not present.
 */
export const SseLastEventId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const lastEventId = request.headers['last-event-id'];
    return lastEventId?.trim() || undefined;
  },
);

// Re-export for convenience
export { SSE_LAST_EVENT_ID_KEY };
