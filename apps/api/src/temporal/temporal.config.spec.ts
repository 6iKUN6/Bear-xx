import {
  getTemporalConnectionOptions,
  getTemporalWorkerConfig,
} from './temporal.config';

describe('Temporal 配置', () => {
  it('缺少 Temporal Worker 必填配置时拒绝启动', () => {
    expect(() => getTemporalWorkerConfig({})).toThrow(
      'TEMPORAL_ADDRESS 未配置',
    );
    expect(() =>
      getTemporalWorkerConfig({
        TEMPORAL_ADDRESS: 'temporal.example.test:7233',
      }),
    ).toThrow('TEMPORAL_NAMESPACE 未配置');
  });

  it('从基础队列推导编排与 Activity 队列，并启用 Temporal Cloud TLS', () => {
    const config = getTemporalWorkerConfig({
      TEMPORAL_ADDRESS: 'team.a1b2c.tmprl.cloud:7233',
      TEMPORAL_NAMESPACE: 'development.a1b2c',
      TEMPORAL_TASK_QUEUE: 'agent-flow',
      TEMPORAL_API_KEY: 'test-api-key',
    });

    expect(config).toEqual({
      address: 'team.a1b2c.tmprl.cloud:7233',
      namespace: 'development.a1b2c',
      orchestratorTaskQueue: 'agent-flow-orchestrator',
      activityTaskQueue: 'agent-flow-activity',
      apiKey: 'test-api-key',
      tls: true,
    });
    expect(getTemporalConnectionOptions(config)).toEqual({
      address: 'team.a1b2c.tmprl.cloud:7233',
      apiKey: 'test-api-key',
      tls: true,
    });
  });

  it('允许私有部署显式覆盖两个 Worker 队列与 TLS 开关', () => {
    const config = getTemporalWorkerConfig({
      TEMPORAL_ADDRESS: 'temporal.internal:7233',
      TEMPORAL_NAMESPACE: 'agent-flow-dev',
      TEMPORAL_TASK_QUEUE: 'agent-flow',
      TEMPORAL_ORCHESTRATOR_TASK_QUEUE: 'flow-orchestrator-v2',
      TEMPORAL_ACTIVITY_TASK_QUEUE: 'flow-activities-v2',
      TEMPORAL_TLS: 'false',
    });

    expect(config.orchestratorTaskQueue).toBe('flow-orchestrator-v2');
    expect(config.activityTaskQueue).toBe('flow-activities-v2');
    expect(config.tls).toBe(false);
  });
});
