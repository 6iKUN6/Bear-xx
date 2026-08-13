import { AsyncLocalStorage } from 'async_hooks';

interface McDonaldsOrderContext {
  taskId: string;
  userId: string;
  conversationId?: string;
  messageId?: string;
  mcdonaldsCredentialId?: string;
  createdOrderIds: string[];
}

const storage = new AsyncLocalStorage<McDonaldsOrderContext>();

/**
 * 在聊天任务的订单上下文中运行函数
 * @param taskId 流式任务ID
 * @param userId 当前任务所属用户ID
 * @param fn 需要在订单上下文中执行的异步函数
 * @param messageContext 当前任务关联的会话与助手消息标识
 * @param credentialContext 本轮任务锁定的用户级麦当劳凭据标识
 * @returns 返回 fn 的执行结果
 * @description 基于 AsyncLocalStorage 隔离并发任务，下单工具无需把用户或任务信息暴露为 MCP 参数。
 */
export function runWithMcDonaldsOrderContext<T>(
  taskId: string,
  userId: string,
  fn: () => Promise<T>,
  messageContext?: { conversationId: string; messageId: string },
  credentialContext?: { mcdonaldsCredentialId?: string },
): Promise<T> {
  return storage.run(
    {
      taskId,
      userId,
      conversationId: messageContext?.conversationId,
      messageId: messageContext?.messageId,
      mcdonaldsCredentialId: credentialContext?.mcdonaldsCredentialId,
      createdOrderIds: [],
    },
    fn,
  );
}

/**
 * 读取当前麦当劳订单任务上下文
 * @returns 返回当前任务的订单上下文
 * @description Agent 工具只能从实际聊天任务调用；离开上下文的 create-order 调用会被拒绝，避免无归属订单入库。
 */
export function requireMcDonaldsOrderContext(): McDonaldsOrderContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error('麦当劳下单工具只能在聊天任务上下文中调用');
  }
  return context;
}

/**
 * 登记本任务刚创建的本地订单
 * @param orderId 本地麦当劳订单ID
 * @returns 无返回值
 * @description 去重后登记，供 StreamTask 在对应工具完成事件后发送安全的 order.created SSE。
 */
export function registerCreatedMcDonaldsOrder(orderId: string): void {
  const context = requireMcDonaldsOrderContext();
  if (!context.createdOrderIds.includes(orderId)) {
    context.createdOrderIds.push(orderId);
  }
}

/**
 * 消费本任务尚未发送 SSE 的订单ID
 * @returns 返回并清空待发送的本地订单ID
 * @description 只允许 StreamTask 在工具完成后调用，避免一张订单在同一会话内重复追加卡片。
 */
export function consumeCreatedMcDonaldsOrderIds(): string[] {
  const context = storage.getStore();
  if (!context) {
    return [];
  }
  const orderIds = [...context.createdOrderIds];
  context.createdOrderIds.length = 0;
  return orderIds;
}
