import {
  consumeCreatedMcDonaldsOrderIds,
  registerCreatedMcDonaldsOrder,
  runWithMcDonaldsOrderContext,
} from './mcdonalds-order-context';

describe('麦当劳订单任务上下文', () => {
  it('隔离任务创建的订单并在消费后清空待发送列表', async () => {
    await runWithMcDonaldsOrderContext('task-1', 'user-1', () => {
      registerCreatedMcDonaldsOrder('order-1');
      registerCreatedMcDonaldsOrder('order-1');
      registerCreatedMcDonaldsOrder('order-2');

      expect(consumeCreatedMcDonaldsOrderIds()).toEqual(['order-1', 'order-2']);
      expect(consumeCreatedMcDonaldsOrderIds()).toEqual([]);
      return Promise.resolve();
    });
  });
});
