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
    let errors: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message =
        typeof res === 'string'
          ? res
          : (res as Record<string, unknown>).message?.toString() ||
            exception.message;
      errors = typeof res === 'string' ? undefined : readErrors(res);
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
      ...(errors ? { errors } : {}),
    });
  }
}

/**
 * 取出业务异常携带的结构化错误明细
 * @param response HttpException 的响应体
 * @returns 形状符合时返回明细数组，否则返回 undefined
 * @description 校验类 400（FlowDefinition 结构、Flow 运行前提等）会在 `errors` 里给出每条
 * 问题的 path / rule / message。这一层原先只取 message，明细被整个丢掉，管理端只能看到
 * 「FlowDefinition 校验失败」这类无法定位的文案，精心设计的 path 从未到达浏览器。
 *
 * 只透出我们自己构造的 `{path, rule, message}` 三元组：形状不符就不透出，避免把第三方
 * 异常挂在 response 上的任意对象（可能含连接串或内部路径）当作明细下发。
 */
function readErrors(response: unknown): unknown[] | undefined {
  const candidate = (response as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(candidate) || candidate.length === 0) {
    return undefined;
  }
  const safe = candidate.filter((item) => {
    const entry = item as Record<string, unknown> | null;
    return (
      typeof entry?.path === 'string' &&
      typeof entry.rule === 'string' &&
      typeof entry.message === 'string'
    );
  });
  return safe.length > 0 ? safe : undefined;
}
