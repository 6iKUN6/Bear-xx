import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule, type Params } from 'nestjs-pino';

const SENSITIVE_HEADER_VALUE = '[Redacted]';
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_LOG_FILE_PATH = 'logs/app.log';

type LogHeaders = Record<string, unknown>;

interface RequestLogValue {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  query?: unknown;
  params?: unknown;
  headers?: LogHeaders;
  remoteAddress?: unknown;
  remotePort?: unknown;
}

interface ResponseLogValue {
  statusCode?: unknown;
  headers?: LogHeaders;
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Params => ({
        pinoHttp: {
          level:
            readConfigString(configService, 'LOG_LEVEL') ?? DEFAULT_LOG_LEVEL,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'req.headers["x-openai-api-key"]',
            ],
            censor: SENSITIVE_HEADER_VALUE,
          },
          serializers: {
            req(req: RequestLogValue) {
              return serializeRequest(req);
            },
            res(res: ResponseLogValue) {
              return serializeResponse(res);
            },
          },
          transport: createLoggerTransport(configService),
          autoLogging: false,
        },
      }),
    }),
  ],
})
export class LoggingModule {}

function serializeRequest(req: RequestLogValue) {
  return {
    id: req.id,
    method: req.method,
    url: req.url,
    query: req.query,
    params: req.params,
    headers: {
      authorization: maskHeaderValue(req.headers?.authorization),
      'user-agent': readHeader(req.headers, 'user-agent'),
      'content-type': readHeader(req.headers, 'content-type'),
      accept: readHeader(req.headers, 'accept'),
    },
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

function serializeResponse(res: ResponseLogValue) {
  return {
    statusCode: res.statusCode,
    headers: {
      'content-type': readHeader(res.headers, 'content-type'),
      'x-ratelimit-limit': readHeader(res.headers, 'x-ratelimit-limit'),
      'x-ratelimit-remaining': readHeader(res.headers, 'x-ratelimit-remaining'),
      'x-ratelimit-reset': readHeader(res.headers, 'x-ratelimit-reset'),
    },
  };
}

function createLoggerTransport(configService: ConfigService) {
  const prettyEnabled =
    readOptionalBoolean(configService, 'LOG_PRETTY') ??
    configService.get<string>('NODE_ENV') !== 'production';
  const fileEnabled =
    readOptionalBoolean(configService, 'LOG_TO_FILE') ?? false;
  const filePath =
    readConfigString(configService, 'LOG_FILE_PATH') ?? DEFAULT_LOG_FILE_PATH;

  if (prettyEnabled && fileEnabled) {
    return {
      targets: [
        {
          target: 'pino-pretty',
          options: { colorize: true },
        },
        {
          target: 'pino/file',
          options: { destination: filePath, mkdir: true },
        },
      ],
    };
  }

  if (prettyEnabled) {
    return {
      target: 'pino-pretty',
      options: { colorize: true },
    };
  }

  if (fileEnabled) {
    return {
      target: 'pino/file',
      options: { destination: filePath, mkdir: true },
    };
  }

  return undefined;
}

function maskHeaderValue(value: unknown) {
  return value ? SENSITIVE_HEADER_VALUE : undefined;
}

function readHeader(headers: LogHeaders | undefined, key: string) {
  const value = headers?.[key];
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string').join(',');
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }

  return undefined;
}

function readOptionalBoolean(
  configService: ConfigService,
  key: string,
): boolean | undefined {
  const value = readConfigString(configService, key);
  if (value === undefined) {
    return undefined;
  }

  if (value === 'true' || value === '1') {
    return true;
  }

  if (value === 'false' || value === '0') {
    return false;
  }

  return undefined;
}

function readConfigString(
  configService: ConfigService,
  key: string,
): string | undefined {
  const value = configService.get<string>(key);
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue === '' ? undefined : trimmedValue;
}
