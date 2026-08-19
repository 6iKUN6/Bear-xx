/** Temporal Worker 的完整运行配置。 */
export interface TemporalWorkerConfig {
  address: string;
  namespace: string;
  orchestratorTaskQueue: string;
  activityTaskQueue: string;
  apiKey?: string;
  tls: boolean;
}

/** 本项目 Temporal SDK 共用的最小连接参数。 */
export interface TemporalConnectionOptions {
  address: string;
  apiKey?: string;
  tls: boolean;
}

type TemporalEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * 从环境变量加载 Temporal Worker 配置
 * @param environment 待读取的环境变量，默认使用当前进程环境
 * @returns 返回已完成格式校验和队列推导的 Worker 配置
 * @description 仅由 Temporal Client 调度或独立 Worker 调用；HTTP API 进程不会在启动时读取该严格配置，因此没有 Flow 派发前不要求部署 Temporal。
 */
export function getTemporalWorkerConfig(
  environment: TemporalEnvironment = process.env,
): TemporalWorkerConfig {
  const address = requireTemporalValue(environment, 'TEMPORAL_ADDRESS');
  const namespace = requireTemporalValue(environment, 'TEMPORAL_NAMESPACE');
  const taskQueue = requireTemporalValue(environment, 'TEMPORAL_TASK_QUEUE');
  const apiKey = readOptionalTemporalValue(environment, 'TEMPORAL_API_KEY');

  return {
    address,
    namespace,
    orchestratorTaskQueue:
      readOptionalTemporalValue(
        environment,
        'TEMPORAL_ORCHESTRATOR_TASK_QUEUE',
      ) ?? `${taskQueue}-orchestrator`,
    activityTaskQueue:
      readOptionalTemporalValue(environment, 'TEMPORAL_ACTIVITY_TASK_QUEUE') ??
      `${taskQueue}-activity`,
    ...(apiKey ? { apiKey } : {}),
    tls: resolveTemporalTls(environment, address),
  };
}

/**
 * 构造 Temporal SDK 连接参数
 * @param config 已通过严格校验的 Temporal Worker 配置
 * @returns 返回不含业务任务数据的连接参数
 * @description 将鉴权和 TLS 限制在连接层，Workflow 输入、Signal 与 History 不携带这类配置。
 */
export function getTemporalConnectionOptions(
  config: TemporalWorkerConfig,
): TemporalConnectionOptions {
  return {
    address: config.address,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    tls: config.tls,
  };
}

/**
 * 读取必填的 Temporal 环境变量
 * @param environment 待读取的环境变量集合
 * @param key 必填配置键名
 * @returns 返回去除首尾空白后的配置值
 * @description 不接受空字符串，确保 Worker 不会隐式退化到 localhost 或 default Namespace。
 */
function requireTemporalValue(
  environment: TemporalEnvironment,
  key: string,
): string {
  const value = readOptionalTemporalValue(environment, key);
  if (!value) {
    throw new Error(`${key} 未配置`);
  }
  return value;
}

/**
 * 读取可选的 Temporal 环境变量
 * @param environment 待读取的环境变量集合
 * @param key 配置键名
 * @returns 返回去除首尾空白后的值，空值返回 undefined
 * @description 统一收敛空字符串，避免不同调用点把空密码或空队列当作有效配置。
 */
function readOptionalTemporalValue(
  environment: TemporalEnvironment,
  key: string,
): string | undefined {
  const value = environment[key]?.trim();
  return value || undefined;
}

/**
 * 解析 Temporal TLS 开关
 * @param environment 待读取的环境变量集合
 * @param address 已校验的 Temporal 地址
 * @returns 返回是否启用 TLS
 * @description 显式 TEMPORAL_TLS 优先；未设置时仅对 Temporal Cloud 地址默认启用 TLS，私有部署默认关闭并可显式开启。
 */
function resolveTemporalTls(
  environment: TemporalEnvironment,
  address: string,
): boolean {
  const configuredValue = readOptionalTemporalValue(
    environment,
    'TEMPORAL_TLS',
  );
  if (!configuredValue) {
    return address.includes('.tmprl.cloud');
  }
  if (configuredValue === 'true') {
    return true;
  }
  if (configuredValue === 'false') {
    return false;
  }
  throw new Error('TEMPORAL_TLS 只能是 true 或 false');
}
