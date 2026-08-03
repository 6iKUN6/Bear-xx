import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

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
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.debug?.(
        `${request.method} ${request.url} -> ${status} ${message}`,
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
