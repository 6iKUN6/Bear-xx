import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RedisService } from './redis/redis.service';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { ConversationModule } from './modules/conversation/conversation.module';
import { ChatModule } from './modules/chat/chat.module';
import { HealthModule } from './modules/health/health.module';
import { LlmModule } from './modules/llm/llm.module';
import { SseTaskModule } from './modules/sse-task/sse-task.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

const SENSITIVE_HEADER_VALUE = '[Redacted]';

function maskHeaderValue(value: unknown) {
  return value ? SENSITIVE_HEADER_VALUE : undefined;
}

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    LoggerModule.forRoot({
      pinoHttp: {
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
          req(req) {
            return {
              id: req.id,
              method: req.method,
              url: req.url,
              query: req.query,
              params: req.params,
              headers: {
                authorization: maskHeaderValue(req.headers?.authorization),
                'user-agent': req.headers?.['user-agent'],
                'content-type': req.headers?.['content-type'],
                accept: req.headers?.accept,
              },
              remoteAddress: req.remoteAddress,
              remotePort: req.remotePort,
            };
          },
          res(res) {
            return {
              statusCode: res.statusCode,
              headers: {
                'content-type': res.headers?.['content-type'],
                'x-ratelimit-limit': res.headers?.['x-ratelimit-limit'],
                'x-ratelimit-remaining': res.headers?.['x-ratelimit-remaining'],
                'x-ratelimit-reset': res.headers?.['x-ratelimit-reset'],
              },
            };
          },
        },
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        autoLogging: true,
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ ttl: 60000, limit: 60 }],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
    AuthModule,
    UserModule,
    LlmModule,
    ConversationModule,
    ChatModule,
    SseTaskModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
