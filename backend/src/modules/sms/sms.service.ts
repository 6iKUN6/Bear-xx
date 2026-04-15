import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async sendCode(phone: string): Promise<void> {
    // Rate limit: 1 code per 60s per phone
    const limitKey = `sms:limit:${phone}`;
    const limited = await this.redis.get(limitKey);
    if (limited) {
      throw new BadRequestException('验证码发送过于频繁，请稍后再试');
    }

    const code = this.generateCode();

    // Store in Redis (5 min TTL)
    await this.redis.set(`sms:${phone}`, code, 'EX', 300);
    // Set rate limit (60s)
    await this.redis.set(limitKey, '1', 'EX', 60);

    // Persist to DB as backup
    await this.prisma.smsCode.create({
      data: {
        phone,
        code,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    // TODO: Integrate actual SMS provider (Aliyun/Tencent Cloud)
    // For development, log the code
    this.logger.log(`[DEV] SMS code for ${phone}: ${code}`);
  }

  async verifyCode(phone: string, code: string): Promise<boolean> {
    const redisKey = `sms:${phone}`;
    const storedCode = await this.redis.get(redisKey);

    if (storedCode && storedCode === code) {
      await this.redis.del(redisKey);
      // Mark DB record as used
      await this.prisma.smsCode.updateMany({
        where: { phone, code, used: false },
        data: { used: true },
      });
      return true;
    }

    // Fallback: check DB if Redis missed
    const dbCode = await this.prisma.smsCode.findFirst({
      where: {
        phone,
        code,
        used: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (dbCode) {
      await this.prisma.smsCode.update({
        where: { id: dbCode.id },
        data: { used: true },
      });
      return true;
    }

    return false;
  }

  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}
