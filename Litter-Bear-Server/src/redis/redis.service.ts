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
      retryStrategy: (times) => {
        if (times > 3) {
          this.logger.warn(
            'Redis connection failed after 3 retries, giving up',
          );
          return null;
        }
        return Math.min(times * 500, 2000);
      },
    });

    this.on('connect', () => this.logger.log('Redis connected'));
    this.on('error', (err) => this.logger.warn(`Redis error: ${err.message}`));

    this.connect().catch(() => {
      // handled by retryStrategy and error event
    });
  }

  onModuleDestroy() {
    this.disconnect();
  }
}
