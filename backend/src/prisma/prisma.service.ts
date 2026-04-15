import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  /**
   * 初始化 Prisma 连接
   * @returns 无返回值
   * @description 在模块启动时尝试建立数据库连接；若连接失败，则记录警告日志但不阻断服务启动。
   */
  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Database connected');
    } catch (error) {
      this.logger.warn(
        `Database connection failed: ${(error as Error).message}. Server will start without DB.`,
      );
    }
  }

  /**
   * 关闭 Prisma 连接
   * @returns 无返回值
   * @description 在模块销毁阶段主动断开 Prisma 与数据库的连接。
   */
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
