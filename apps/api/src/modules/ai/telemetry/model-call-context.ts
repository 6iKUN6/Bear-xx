import { AsyncLocalStorage } from 'async_hooks';

/**
 * 单轮任务的模型调用计数上下文
 * @description ReAct/Plan 循环内的多次模型往返折叠在消息流里、不逐次发事件，
 * 靠 trace 会漏计。用 AsyncLocalStorage 在任务执行期建立上下文，模型构造处挂的
 * LangChain 回调（handleChatModelStart）在每次真实调用时 +1，任务完成时读取累计值。
 * ALS 跨 await 传播，能把并发任务的计数隔离在各自上下文，互不串扰。
 */
interface ModelCallContext {
  taskId: string;
  counter: { model: number };
}

const storage = new AsyncLocalStorage<ModelCallContext>();

/**
 * 在模型调用计数上下文中执行
 * @param taskId 任务标识
 * @param fn 任务执行体
 * @returns 返回 fn 的结果
 * @description 包裹任务的 agent 执行段；期间的模型调用回调都会累计到本上下文。
 */
export function runWithModelCallContext<T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ taskId, counter: { model: 0 } }, fn);
}

/**
 * 累加一次模型调用
 * @description 由 chat-model.factory 挂的 LangChain 回调在每次模型调用开始时触发；
 * 不在上下文中（如后台摘要任务）时静默忽略。
 */
export function incrementModelCall(): void {
  const context = storage.getStore();
  if (context) {
    context.counter.model += 1;
  }
}

/**
 * 读取当前上下文累计的模型调用次数
 * @returns 返回次数；不在上下文中时返回 0
 */
export function getModelCallCount(): number {
  return storage.getStore()?.counter.model ?? 0;
}
