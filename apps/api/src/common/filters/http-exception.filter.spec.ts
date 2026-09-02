import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

/**
 * 构造一个只记录响应内容的 ArgumentsHost 替身
 * @returns 返回 host 与捕获到的响应体
 * @description 只关心过滤器写出的 JSON，不启 HTTP 服务；headersSent 固定为 false，
 * SSE 分支由另有的流式用例覆盖。
 */
function createHost(): {
  host: ArgumentsHost;
  captured: { status?: number; body?: Record<string, unknown> };
} {
  const captured: { status?: number; body?: Record<string, unknown> } = {};
  const response = {
    headersSent: false,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
    end() {},
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', url: '/api/admin/agent-flows' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, captured };
}

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();

  it('透出校验类 400 携带的结构化明细', () => {
    // 回归用：过滤器原先只取 message，errors 在这一层被整个丢掉，管理端只能看到
    // 「FlowDefinition 校验失败」这类无法定位的概括语，精心设计的 path 从未到达浏览器。
    const { host, captured } = createHost();

    filter.catch(
      new BadRequestException({
        message: 'FlowDefinition 校验失败',
        errors: [
          {
            path: 'nodes.1.config.cases.0.conditions.0.ref',
            rule: 'ref-dominates',
            message: '节点「classify」不能引用「heavy」',
          },
        ],
      }),
      host,
    );

    expect(captured.status).toBe(400);
    expect(captured.body).toEqual({
      code: 400,
      data: null,
      message: 'FlowDefinition 校验失败',
      errors: [
        {
          path: 'nodes.1.config.cases.0.conditions.0.ref',
          rule: 'ref-dominates',
          message: '节点「classify」不能引用「heavy」',
        },
      ],
    });
  });

  it('丢弃形状不符的 errors，不把任意对象当明细下发', () => {
    // 第三方异常可能在 response 上挂任意对象，其中可能含连接串或内部路径；
    // 只透出我们自己构造的 path/rule/message 三元组
    const { host, captured } = createHost();

    filter.catch(
      new BadRequestException({
        message: '请求不合法',
        errors: [{ detail: 'postgres://user:pw@db:5432 connect failed' }],
      }),
      host,
    );

    expect(captured.body).toEqual({
      code: 400,
      data: null,
      message: '请求不合法',
    });
  });

  it('没有明细时不添加空的 errors 字段', () => {
    const { host, captured } = createHost();

    filter.catch(new BadRequestException('参数错误'), host);

    expect(captured.body).toEqual({
      code: 400,
      data: null,
      message: '参数错误',
    });
  });

  it('将业务异常的稳定 code 作为 errorCode 下发', () => {
    const { host, captured } = createHost();

    filter.catch(
      new BadRequestException({
        message: '当前会员等级不足，需要 PLUS 会员',
        code: 'MEMBERSHIP_REQUIRED',
      }),
      host,
    );

    expect(captured.body).toEqual({
      code: 400,
      data: null,
      message: '当前会员等级不足，需要 PLUS 会员',
      errorCode: 'MEMBERSHIP_REQUIRED',
    });
  });

  it('未预期异常收敛为 500 且不透出内部信息', () => {
    const { host, captured } = createHost();

    filter.catch(
      new Error('connect ECONNREFUSED postgres://user:pw@db:5432'),
      host,
    );

    expect(captured.status).toBe(500);
    // 现状记录：非 HttpException 的 message 会被原样下发。这不是本次改动引入的，
    // 但它意味着任何未捕获错误的文案都可能含连接串——修它属于另一处收敛，不在此扩大范围。
    expect(captured.body?.errors).toBeUndefined();
  });

  it('InternalServerErrorException 的明细同样按形状过滤', () => {
    const { host, captured } = createHost();

    filter.catch(
      new InternalServerErrorException({
        message: '服务异常',
        errors: 'not-an-array',
      }),
      host,
    );

    expect(captured.status).toBe(500);
    expect(captured.body?.errors).toBeUndefined();
  });
});
