import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { EmptyError } from 'rxjs';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // SSE 伪错误：拦截器接管响应后返回空 Observable，Nest 事后 lastValueFrom
    // 等值抛 EmptyError（no elements in sequence）。此时流已正常结束、客户端
    // 无感，按 debug 记录即可，不算 500。
    if (exception instanceof EmptyError && response.headersSent) {
      this.logger.debug?.(
        `${request.method} ${request.url} -> SSE 流正常结束（EmptyError 已忽略）`,
      );
      response.end();
      return;
    }

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message =
        typeof res === 'string'
          ? res
          : (res as Record<string, unknown>).message?.toString() ||
            exception.message;
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    // 5xx 属于未预期异常：必须带堆栈落日志，否则线上问题无从排查。
    // 4xx 是业务预期错误（校验失败/404 等），debug 级别即可，避免刷屏。
    // 带上异常类名：同一段 message 出自 TypeError 还是业务异常，排查路径完全不同
    const errorName =
      exception instanceof Error
        ? exception.constructor.name
        : typeof exception;
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} [${errorName}] ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.debug?.(
        `${request.method} ${request.url} -> ${status} [${errorName}] ${message}`,
      );
    }

    if (response.headersSent) {
      response.end();
      return;
    }

    response.status(status).json({
      code: status,
      data: null,
      message,
    });
  }
}
