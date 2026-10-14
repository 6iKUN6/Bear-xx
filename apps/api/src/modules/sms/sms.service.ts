import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
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

  /**
   * 发送短信验证码
   * @param phone 手机号
   * @returns 无返回值
   * @description 生成六位验证码并写入 Redis，同时持久化到数据库作为兜底，并对发送频率进行限制。
   * 尚未接入短信供应商：生产环境无法真正下发验证码，直接返回 503，不生成也不记录验证码；
   * 非生产环境把验证码打到日志供本地登录。
   */
  async sendCode(phone: string): Promise<void> {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new ServiceUnavailableException('短信验证码服务暂未开放');
    }

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

    // TODO: 接入短信供应商（阿里云 / 腾讯云）后移除上方的生产环境拦截与本日志
    this.logger.log(`[DEV] SMS code for ${phone}: ${code}`);
  }

  /**
   * 校验短信验证码
   * @param phone 手机号
   * @param code 验证码
   * @returns 返回校验结果，true 表示验证码有效，false 表示无效或已过期
   * @description 优先校验 Redis 中的验证码；若 Redis 未命中，则回退到数据库中的未使用记录进行校验。
   */
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

  /**
   * 生成六位数字验证码
   * @returns 返回六位数字字符串
   * @description 生成用于短信登录的随机数字验证码。
   */
  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}
