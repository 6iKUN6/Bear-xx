// class-validator 的装饰器元数据依赖此 polyfill。其他用例经 @nestjs/testing 间接加载，
// 本用例刻意不引入 Nest（否则 import 期就会校验开发者本机的 .env），故显式引入。
import 'reflect-metadata';
import { validateEnvironment } from './env.validation';

/** 32 字节随机值的 base64，仅用于校验测试，不是任何真实密钥 */
const VALID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * 构造仅含必填项的最小环境
 * @param overrides 需要覆盖或追加的键值
 * @returns 返回可交给 validateEnvironment 的环境对象
 */
function minimalEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    DATABASE_URL: 'postgresql://localhost/litter_bear',
    REDIS_HOST: 'localhost',
    JWT_ACCESS_SECRET: 'access-secret',
    JWT_REFRESH_SECRET: 'refresh-secret',
    LLM_CREDENTIAL_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
    ...overrides,
  };
}

describe('环境配置校验', () => {
  it('未使用麦当劳功能且尚未启用 Flow 派发时允许可选配置为空', () => {
    expect(() =>
      validateEnvironment(
        minimalEnvironment({
          MCDONALDS_CREDENTIAL_ENCRYPTION_KEY: '',
          MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY: '',
          TEMPORAL_ADDRESS: '',
          TEMPORAL_NAMESPACE: '',
          TEMPORAL_TASK_QUEUE: '',
        }),
      ),
    ).not.toThrow();
  });

  it('缺少模型密钥加密主密钥时启动失败', () => {
    // 模型配置的唯一来源是库里的密文；没有主密钥就一次调用都发不出去，
    // 放过它只会把失败推迟到管理员保存预设或首次模型调用时
    const environment = minimalEnvironment();
    delete (environment as Record<string, unknown>)
      .LLM_CREDENTIAL_ENCRYPTION_KEY;

    expect(() => validateEnvironment(environment)).toThrow(
      /LLM_CREDENTIAL_ENCRYPTION_KEY/,
    );
  });

  it('模型密钥加密主密钥为空串时同样启动失败', () => {
    // 「键存在但值为空」是 .env 最常见的半配置状态，不能当作已配置
    expect(() =>
      validateEnvironment(
        minimalEnvironment({ LLM_CREDENTIAL_ENCRYPTION_KEY: '' }),
      ),
    ).toThrow(/LLM_CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('模型密钥加密主密钥含非 base64 字符时启动失败', () => {
    expect(() =>
      validateEnvironment(
        minimalEnvironment({
          LLM_CREDENTIAL_ENCRYPTION_KEY: 'not a base64 key!',
        }),
      ),
    ).toThrow(/LLM_CREDENTIAL_ENCRYPTION_KEY/);
  });
});
