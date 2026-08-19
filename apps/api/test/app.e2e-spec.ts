import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { RedisService } from './../src/redis/redis.service';
import { AgentCheckpointerService } from './../src/modules/ai/agents/common-chat-agent';
import { AgentFlowSignalOutboxService } from './../src/modules/agent-flow/temporal/agent-flow-signal-outbox.service';
import { AgentFlowCancellationDispatcherService } from './../src/modules/agent-flow/temporal/agent-flow-cancellation-dispatcher.service';

describe('健康检查（E2E）', () => {
  let app: INestApplication<App>;
  const prisma = {
    $queryRawUnsafe: jest.fn().mockResolvedValue(1),
    modelPreset: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const redis = {
    ping: jest.fn().mockResolvedValue('PONG'),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue(redis)
      .overrideProvider(AgentCheckpointerService)
      .useValue({ get: jest.fn() })
      .overrideProvider(AgentFlowSignalOutboxService)
      .useValue({})
      .overrideProvider(AgentFlowCancellationDispatcherService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health 返回数据库与 Redis 的健康状态', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          code: 200,
          data: {
            status: 'ok',
            info: {
              database: { status: 'up' },
              redis: { status: 'up' },
            },
            error: {},
            details: {
              database: { status: 'up' },
              redis: { status: 'up' },
            },
          },
          message: 'success',
        });
      });
  });
});
