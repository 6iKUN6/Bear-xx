import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { SSE_OPTIONS_KEY } from '../sse/sse.types';

export interface ApiResponse<T> {
  code: number;
  data: T;
  message: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    // Skip SSE endpoints — they handle their own response format
    const sseOptions = this.reflector.get<Record<string, unknown> | undefined>(
      SSE_OPTIONS_KEY,
      context.getHandler(),
    );
    if (sseOptions !== undefined) {
      return next.handle() as Observable<ApiResponse<T>>;
    }

    return next.handle().pipe(
      map((data: T) => ({
        code: 200,
        data,
        message: 'success',
      })),
    );
  }
}
