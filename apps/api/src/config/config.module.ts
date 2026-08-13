import { Module, Global } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { EnvConfig } from './env.validation';

/**
 * 校验应用环境变量
 * @param config 原始环境变量键值对
 * @returns 返回已转换并通过校验的环境变量对象
 * @description 供 Nest 启动时与配置单元测试共用，校验失败时抛出包含字段信息的错误。
 */
export function validateEnvironment(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvConfig, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(`Config validation error:\n${errors.toString()}`);
  }
  return validated;
}

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      validate: validateEnvironment,
    }),
  ],
})
export class ConfigModule {}
