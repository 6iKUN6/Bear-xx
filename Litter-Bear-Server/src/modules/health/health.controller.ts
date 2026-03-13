import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      return this.getStatus('database', true);
    } catch {
      return this.getStatus('database', false);
    }
  }
}

class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async isHealthy(): Promise<HealthIndicatorResult> {
    try {
      const result = await this.redis.ping();
      return this.getStatus('redis', result === 'PONG');
    } catch {
      return this.getStatus('redis', false);
    }
  }
}

@ApiTags('健康检查')
@SkipThrottle()
@Controller('health')
export class HealthController {
  private readonly prismaHealth: PrismaHealthIndicator;
  private readonly redisHealth: RedisHealthIndicator;

  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.prismaHealth = new PrismaHealthIndicator(prisma);
    this.redisHealth = new RedisHealthIndicator(redis);
  }

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: '健康检查',
    description: '检查数据库和 Redis 连接状态',
  })
  check() {
    return this.health.check([
      () => this.prismaHealth.isHealthy(),
      () => this.redisHealth.isHealthy(),
    ]);
  }
}
