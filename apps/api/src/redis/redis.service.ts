import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(private readonly configService: ConfigService) {
    super({
      host: configService.get('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
      password: configService.get('REDIS_PASSWORD') || undefined,
      lazyConnect: true,
      // 无限退避重连：Redis 抖动/重启后自愈，避免"重试几次后永久放弃 → 之后所有命令报
      // Connection is closed."。退避上限 5s；每 10 次重连告警一次，避免日志刷屏。
      retryStrategy: (times) => {
        const delay = Math.min(times * 200, 5000);
        if (times === 1 || times % 10 === 0) {
          this.logger.warn(
            `Redis reconnecting (attempt ${times}), retry in ${delay}ms`,
          );
        }
        return delay;
      },
    });

    this.on('connect', () => this.logger.log('Redis connected'));
    this.on('error', (err) => this.logger.warn(`Redis error: ${err.message}`));

    this.connect().catch(() => {
      // handled by retryStrategy and error event
    });
  }

  /**
   * 关闭 Redis 连接
   * @returns 无返回值
   * @description 在模块销毁阶段主动断开 Redis 连接，释放底层资源。
   */
  onModuleDestroy() {
    this.disconnect();
  }
}
