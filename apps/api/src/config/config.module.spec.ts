import { validateEnvironment } from './config.module';

describe('环境配置校验', () => {
  it('未使用麦当劳功能时允许加密密钥为空', () => {
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'postgresql://localhost/litter_bear',
        REDIS_HOST: 'localhost',
        JWT_ACCESS_SECRET: 'access-secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
        MCDONALDS_CREDENTIAL_ENCRYPTION_KEY: '',
        MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY: '',
      }),
    ).not.toThrow();
  });
});
