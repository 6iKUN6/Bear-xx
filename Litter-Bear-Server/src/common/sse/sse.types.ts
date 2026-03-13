import type { Request } from 'express';

export interface SseRequest extends Request {
  __sseAbortSignal?: AbortSignal;
}

export interface SseEvent {
  id: string;
  event: string;
  data: string;
}

export interface SseOptions {
  /** Heartbeat interval in ms (default: from SSE_HEARTBEAT_INTERVAL env, or 15000) */
  heartbeatMs?: number;
  /** Redis buffer TTL in seconds (default: from SSE_BUFFER_TTL env, or 300) */
  bufferTtl?: number;
  /** Redis key prefix for event buffer (default: 'sse:buffer') */
  bufferKeyPrefix?: string;
}

export const SSE_OPTIONS_KEY = 'SSE_OPTIONS';
export const SSE_LAST_EVENT_ID_KEY = 'SSE_LAST_EVENT_ID';
