import { validateEnvironment } from './config.module';

describe('环境配置校验', () => {
  it('未使用麦当劳功能且尚未启用 Flow 派发时允许可选配置为空', () => {
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'postgresql://localhost/litter_bear',
        REDIS_HOST: 'localhost',
        JWT_ACCESS_SECRET: 'access-secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
        MCDONALDS_CREDENTIAL_ENCRYPTION_KEY: '',
        MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY: '',
        TEMPORAL_ADDRESS: '',
        TEMPORAL_NAMESPACE: '',
        TEMPORAL_TASK_QUEUE: '',
      }),
    ).not.toThrow();
  });
});
