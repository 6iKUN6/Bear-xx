/**
 * 渲染 Activity 允许运行的工作进程角色
 * @description 渲染会启动浏览器与 ffmpeg，属于重资源副作用，只允许独立 Activity Worker 承担。
 * 编排 Worker 运行在 Temporal 的隔离 VM 里本来就没有 Node 能力，但 API 进程的内嵌 Worker
 * 同样能注册 Activity —— 那会把渲染塞进处理 HTTP 的进程里，一次 30 分钟的渲染足以拖垮接口。
 */
export const RENDER_WORKER_ROLE = 'activity';

/** 渲染角色校验失败的错误码；Activity 层据此转成不可重试失败。 */
export const RENDER_WORKER_ROLE_ERROR = 'AGENT_FLOW_RENDER_WORKER_ROLE';

/**
 * 校验当前进程是否允许执行渲染
 * @param environment 待读取的环境变量集合
 * @returns 无返回值；角色不符时抛出带固定错误码的异常
 * @description 要求显式声明 `TEMPORAL_WORKER_ROLE=activity`，缺省同样拒绝：内嵌 Worker 模式
 * 不设置该变量，而那种进程不应该承担渲染。错误信息不包含任何环境变量值。
 */
export function assertRenderWorkerRole(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const role = environment.TEMPORAL_WORKER_ROLE?.trim();
  if (role === RENDER_WORKER_ROLE) {
    return;
  }
  const error = new Error(
    `渲染节点只允许在 TEMPORAL_WORKER_ROLE=${RENDER_WORKER_ROLE} 的 Activity Worker 中执行`,
  );
  error.name = RENDER_WORKER_ROLE_ERROR;
  throw error;
}
